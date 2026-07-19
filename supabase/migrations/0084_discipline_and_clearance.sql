-- Disciplinary process, exit clearance, and the guard service timeline
-- (spec section 12).
--
-- Disciplinary: "three-warnings process tracked (warning 1/2/3 with dates &
-- reasons), auto-escalation to termination review; severe cases -> immediate
-- termination path."
--
-- Exit & clearance: "system-generated clearance certificate gated on kit
-- returned (inventory link), no advance outstanding (payroll link), incident
-- review. Final dues release only on completed clearance."
--
-- Service history: "one timeline — postings, transfers, warnings, incidents,
-- training."

-- ===========================================================================
-- 1. Disciplinary warnings
-- ===========================================================================

create table if not exists public.disciplinary_warnings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  -- 1/2/3; the number is assigned by the trigger below, never by the caller,
  -- so it always reflects the true count of active warnings.
  warning_number integer not null,
  issued_on      date not null default current_date,
  reason         text not null,
  issued_by      uuid,
  -- A warning can be rescinded on appeal; rescinded ones stop counting toward
  -- escalation but stay on the record.
  rescinded      boolean not null default false,
  rescinded_reason text,
  created_at     timestamptz not null default now(),
  constraint warning_number_range check (warning_number between 1 and 3)
);

create index if not exists idx_dw_employee on public.disciplinary_warnings(employee_id, issued_on);

drop trigger if exists trg_aaa_dw_fill_company on public.disciplinary_warnings;
create trigger trg_aaa_dw_fill_company
  before insert on public.disciplinary_warnings
  for each row execute function public.fill_company_id();

alter table public.disciplinary_warnings enable row level security;
drop policy if exists "ssa_all" on public.disciplinary_warnings;
create policy "ssa_all" on public.disciplinary_warnings for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.disciplinary_warnings;
create policy "company_members" on public.disciplinary_warnings for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- A flag the UI raises on: the employee has hit three active warnings and is
-- awaiting a termination-review decision. Not an auto-termination — the spec
-- says "auto-escalation to termination REVIEW", a human still decides.
alter table public.employees
  add column if not exists pending_termination_review boolean not null default false;

-- Assign the next warning number and escalate on the third. Counting active
-- (non-rescinded) warnings here means a rescinded warning correctly frees up
-- the slot instead of leaving someone one strike from termination on a warning
-- that was overturned.
create or replace function public.assign_warning_and_escalate()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_active integer;
begin
  select count(*) into v_active
    from public.disciplinary_warnings
   where employee_id = new.employee_id and not rescinded;

  -- +1 for the row being inserted; cap at 3 (further offences ride on #3 until
  -- the review resolves).
  new.warning_number := least(v_active + 1, 3);
  return new;
end;
$$;

drop trigger if exists trg_dw_assign_number on public.disciplinary_warnings;
create trigger trg_dw_assign_number
  before insert on public.disciplinary_warnings
  for each row execute function public.assign_warning_and_escalate();

-- After the row lands, recompute the escalation flag from the true count.
create or replace function public.refresh_termination_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := coalesce(new.employee_id, old.employee_id);
  v_active integer;
begin
  select count(*) into v_active
    from public.disciplinary_warnings
   where employee_id = v_emp and not rescinded;

  update public.employees
     set pending_termination_review = (v_active >= 3),
         updated_at = now()
   where id = v_emp;
  return null;
end;
$$;

drop trigger if exists trg_dw_refresh_review on public.disciplinary_warnings;
create trigger trg_dw_refresh_review
  after insert or update or delete on public.disciplinary_warnings
  for each row execute function public.refresh_termination_review();

-- ===========================================================================
-- 2. Exit clearance
-- ===========================================================================

do $$ begin
  create type public.clearance_status as enum ('pending', 'cleared', 'blocked');
exception when duplicate_object then null; end $$;

create table if not exists public.clearance_certificates (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  employee_id       uuid not null references public.employees(id) on delete cascade,
  initiated_on      date not null default current_date,
  status            public.clearance_status not null default 'pending',
  -- Snapshot of each gate at the moment of assessment, for the certificate.
  kit_returned      boolean,
  outstanding_kit_count integer,
  advance_settled   boolean,
  outstanding_advance   numeric(16,2),
  incidents_reviewed boolean,
  open_incident_count integer,
  dues_released     boolean not null default false,
  dues_released_on  date,
  cleared_by        uuid,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_cc_employee on public.clearance_certificates(employee_id);

drop trigger if exists trg_aaa_cc_fill_company on public.clearance_certificates;
create trigger trg_aaa_cc_fill_company
  before insert on public.clearance_certificates
  for each row execute function public.fill_company_id();

alter table public.clearance_certificates enable row level security;
drop policy if exists "ssa_all" on public.clearance_certificates;
create policy "ssa_all" on public.clearance_certificates for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.clearance_certificates;
create policy "company_members" on public.clearance_certificates for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- The three gates, each computed from its own source of truth.
--   kit:      issuances not yet returned (return_date is null)
--   advance:  sum(advances) - sum(payslip advance recoveries)
--   incident: incidents linked to the guard that aren't closed
create or replace function public.employee_clearance_gates(p_employee_id uuid)
returns table (
  outstanding_kit_count integer,
  outstanding_advance   numeric,
  open_incident_count   integer
) language sql stable security definer set search_path = public as $$
  select
    (select count(*)::integer from public.issuances i
      where i.employee_id = p_employee_id and i.return_date is null),
    (select coalesce(sum(a.amount), 0) from public.advances a where a.employee_id = p_employee_id)
      - (select coalesce(sum(p.advance), 0) from public.payslips p where p.employee_id = p_employee_id),
    (select count(*)::integer
       from public.incident_guards ig
       join public.incidents inc on inc.id = ig.incident_id
      where ig.employee_id = p_employee_id and inc.status <> 'closed');
$$;

-- Assess (or re-assess) clearance: snapshot the gates and set the status.
-- 'cleared' requires all three gates satisfied. It never releases dues — that
-- is a separate, deliberate act (release_final_dues) so money is not paid out
-- as a side effect of a status calculation.
create or replace function public.assess_clearance(p_employee_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g        record;
  v_id     uuid;
  v_ok     boolean;
  v_company uuid;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  select * into g from public.employee_clearance_gates(p_employee_id);
  v_ok := g.outstanding_kit_count = 0 and g.outstanding_advance <= 0 and g.open_incident_count = 0;

  -- One live certificate per employee: reuse the existing pending/blocked one.
  select id into v_id from public.clearance_certificates
   where employee_id = p_employee_id and not dues_released
   order by created_at desc limit 1;

  if v_id is null then
    insert into public.clearance_certificates (company_id, employee_id)
    values (v_company, p_employee_id) returning id into v_id;
  end if;

  update public.clearance_certificates set
    kit_returned          = (g.outstanding_kit_count = 0),
    outstanding_kit_count = g.outstanding_kit_count,
    advance_settled       = (g.outstanding_advance <= 0),
    outstanding_advance   = g.outstanding_advance,
    incidents_reviewed    = (g.open_incident_count = 0),
    open_incident_count   = g.open_incident_count,
    status                = (case when v_ok then 'cleared' else 'blocked' end)::public.clearance_status,
    cleared_by            = case when v_ok then auth.uid() else cleared_by end,
    updated_at            = now()
  where id = v_id;

  return v_id;
end;
$$;

-- Final dues release. Refuses unless clearance is cleared — this is the
-- enforcement of "final dues release only on completed clearance".
create or replace function public.release_final_dues(p_employee_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_status public.clearance_status;
begin
  v_id := public.assess_clearance(p_employee_id);  -- always assess fresh first
  select status into v_status from public.clearance_certificates where id = v_id;

  if v_status <> 'cleared' then
    raise exception 'clearance is not complete; final dues cannot be released'
      using errcode = '23514',
            hint = 'Return kit, settle advances, and close incident reviews first.';
  end if;

  update public.clearance_certificates
     set dues_released = true, dues_released_on = current_date, updated_at = now()
   where id = v_id;
end;
$$;

-- ===========================================================================
-- 3. Guard service history — the one timeline.
-- ===========================================================================

create or replace view public.employee_service_history
  with (security_invoker = true) as
  -- lifecycle transitions
  select ele.employee_id, ele.company_id, 'lifecycle'::text as kind,
         ele.changed_at as event_at,
         (ele.from_state || ' → ' || ele.to_state)::text as title,
         ele.reason as detail
    from public.employee_lifecycle_events ele
  union all
  -- disciplinary warnings
  select dw.employee_id, dw.company_id, 'warning',
         dw.issued_on::timestamptz,
         ('Warning ' || dw.warning_number || case when dw.rescinded then ' (rescinded)' else '' end),
         dw.reason
    from public.disciplinary_warnings dw
  union all
  -- incidents the guard was linked to
  select ig.employee_id, inc.company_id, 'incident',
         inc.occurred_at,
         ('Incident: ' || coalesce(inc.category::text, 'event')),
         inc.description
    from public.incident_guards ig
    join public.incidents inc on inc.id = ig.incident_id
  union all
  -- training & competence
  select tr.employee_id, tr.company_id, 'training',
         tr.completed_on::timestamptz,
         tr.kind::text,
         tr.notes
    from public.employee_training_records tr
  union all
  -- code/branch (posting & transfer) history
  select ech.employee_id, ech.company_id, 'posting',
         ech.changed_at,
         ('Code ' || coalesce(ech.old_code, '—') || ' → ' || coalesce(ech.new_code, '—')),
         ech.reason
    from public.employee_code_history ech;
