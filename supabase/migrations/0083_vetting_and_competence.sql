-- Vetting gate + training & competence (spec section 12).
--
-- Vetting: "police character certificate + NADRA Verisys as statuses
-- (pending/cleared/adverse). Pending = flagged everywhere, blocked from
-- armed/sensitive posts; adverse = auto stand-down + review."
--
-- Training: "orientation done, weapons certification (gates armed posts),
-- refreshers due."
--
-- Both are expressed as one derived question — can this person hold an
-- armed/sensitive post? — so the roster and any future post-assignment check
-- has a single function to call rather than re-deriving the rule.

do $$ begin
  create type public.vetting_status as enum ('pending', 'cleared', 'adverse');
exception when duplicate_object then null; end $$;

alter table public.employees
  add column if not exists police_verification_status public.vetting_status not null default 'pending',
  add column if not exists police_verification_date   date,
  add column if not exists nadra_verisys_status       public.vetting_status not null default 'pending',
  add column if not exists nadra_verisys_date         date,
  -- Competence
  add column if not exists orientation_done       boolean not null default false,
  add column if not exists orientation_date       date,
  add column if not exists weapons_certified      boolean not null default false,
  add column if not exists weapons_cert_expiry    date,
  add column if not exists refresher_due_date     date;

create index if not exists idx_emp_police_vetting on public.employees(company_id, police_verification_status);
create index if not exists idx_emp_nadra_vetting  on public.employees(company_id, nadra_verisys_status);

-- ---------------------------------------------------------------------------
-- Timeline of training events (orientation, certification, refreshers). The
-- boolean flags above are the CURRENT competence; this is the history that
-- feeds the guard service timeline.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.training_kind as enum
    ('orientation', 'weapons_certification', 'weapons_refresher', 'refresher', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.employee_training_records (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  kind          public.training_kind not null,
  completed_on  date not null,
  expires_on    date,
  provider      text,
  notes         text,
  recorded_by   uuid,
  created_at    timestamptz not null default now()
);

create index if not exists idx_etr_employee on public.employee_training_records(employee_id, completed_on);

drop trigger if exists trg_aaa_etr_fill_company on public.employee_training_records;
create trigger trg_aaa_etr_fill_company
  before insert on public.employee_training_records
  for each row execute function public.fill_company_id();

alter table public.employee_training_records enable row level security;
drop policy if exists "ssa_all" on public.employee_training_records;
create policy "ssa_all" on public.employee_training_records for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.employee_training_records;
create policy "company_members" on public.employee_training_records for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Recording weapons certification keeps the employee flag & expiry in step, so
-- the armed-post gate reads one place.
create or replace function public.sync_competence_from_training()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'orientation' then
    update public.employees
       set orientation_done = true,
           orientation_date = coalesce(orientation_date, new.completed_on),
           updated_at = now()
     where id = new.employee_id;
  elsif new.kind in ('weapons_certification', 'weapons_refresher') then
    update public.employees
       set weapons_certified   = true,
           weapons_cert_expiry = new.expires_on,
           updated_at = now()
     where id = new.employee_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_etr_sync_competence on public.employee_training_records;
create trigger trg_etr_sync_competence
  after insert on public.employee_training_records
  for each row execute function public.sync_competence_from_training();

-- ---------------------------------------------------------------------------
-- The single armed/sensitive-post eligibility question.
--
-- Both vetting checks must be CLEARED (pending or adverse both fail), weapons
-- certification must be current (certified and not expired), and the person
-- must actually be in service. Returns the reasons so the UI can say WHY,
-- rather than just yes/no.
-- ---------------------------------------------------------------------------

create or replace function public.armed_post_blockers(p_employee_id uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select array_remove(array[
    case when e.lifecycle_state <> 'active' then 'not in active service' end,
    case when e.police_verification_status = 'pending' then 'police verification pending' end,
    case when e.police_verification_status = 'adverse' then 'police verification adverse' end,
    case when e.nadra_verisys_status = 'pending' then 'NADRA Verisys pending' end,
    case when e.nadra_verisys_status = 'adverse' then 'NADRA Verisys adverse' end,
    case when not e.weapons_certified then 'not weapons-certified' end,
    case when e.weapons_certified and e.weapons_cert_expiry is not null
              and e.weapons_cert_expiry < current_date then 'weapons certification expired' end,
    case when e.blacklisted then 'blacklisted' end
  ], null)
  from public.employees e where e.id = p_employee_id;
$$;

create or replace function public.can_work_armed_post(p_employee_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(array_length(public.armed_post_blockers(p_employee_id), 1), 0) = 0;
$$;

-- ---------------------------------------------------------------------------
-- Adverse vetting => automatic stand-down (active -> on_leave), logged as a
-- lifecycle event like any other. Fires only on the transition INTO adverse,
-- so re-saving an already-adverse record does nothing.
-- ---------------------------------------------------------------------------

create or replace function public.auto_standdown_on_adverse_vetting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_became_adverse boolean;
  v_which text;
begin
  v_became_adverse :=
       (new.police_verification_status = 'adverse' and old.police_verification_status is distinct from 'adverse')
    or (new.nadra_verisys_status       = 'adverse' and old.nadra_verisys_status       is distinct from 'adverse');

  if v_became_adverse and new.lifecycle_state = 'active' then
    v_which := case when new.police_verification_status = 'adverse'
                        and old.police_verification_status is distinct from 'adverse'
                    then 'police verification' else 'NADRA Verisys' end;
    -- Uses the blessed transition path; active -> on_leave needs no reason, and
    -- re-entrancy is impossible because the row is no longer 'active' after.
    perform public.transition_employee_lifecycle(
      new.id, 'on_leave', null, null,
      'Auto stand-down: ' || v_which || ' returned adverse');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_emp_auto_standdown on public.employees;
create trigger trg_emp_auto_standdown
  after update of police_verification_status, nadra_verisys_status on public.employees
  for each row execute function public.auto_standdown_on_adverse_vetting();

-- ---------------------------------------------------------------------------
-- Company-wide verification dashboard source (spec: "per region").
-- ---------------------------------------------------------------------------

create or replace view public.vetting_dashboard
  with (security_invoker = true) as
  select e.company_id,
         e.branch_id,
         b.name as region_name,
         count(*)                                                         as total,
         count(*) filter (where e.police_verification_status = 'pending') as police_pending,
         count(*) filter (where e.police_verification_status = 'adverse') as police_adverse,
         count(*) filter (where e.nadra_verisys_status = 'pending')       as nadra_pending,
         count(*) filter (where e.nadra_verisys_status = 'adverse')       as nadra_adverse,
         count(*) filter (where not e.weapons_certified)                  as not_weapons_certified,
         count(*) filter (where e.weapons_certified and e.weapons_cert_expiry < current_date)
                                                                          as weapons_cert_expired
    from public.employees e
    left join public.branches b on b.id = e.branch_id
   where e.lifecycle_state in ('active', 'on_leave')
   group by e.company_id, e.branch_id, b.name;
