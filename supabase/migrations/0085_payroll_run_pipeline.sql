-- Payroll run pipeline with an approval gate (spec section 13).
--
-- "Run pipeline: Draft -> Review -> Approve (COO/Finance sign-off LOCKS the
-- run — new gate) -> Disburse -> Complete (journals posted, archived)."
--
-- Today payslips are standalone rows with a `disbursed` flag, and the §4
-- journal posts the moment `disbursed` flips true. That stays. This wraps a
-- RUN around a period's payslips and puts a hard approval gate in front of
-- disbursement: an unapproved run cannot pay anyone, and once approved the
-- money figures freeze — only the act of disbursing may touch a payslip.
--
-- Two streams (spec §13): guards & field vs salaried staff. A run is one
-- stream, so the two can be generated, reviewed and approved independently on
-- their own cadences.

do $$ begin
  create type public.payroll_run_status as enum
    ('draft', 'review', 'approved', 'disbursed', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payroll_stream as enum ('guard_field', 'salaried');
exception when duplicate_object then null; end $$;

-- office_staff are the salaried stream; guards and relievers are field.
create or replace function public.employee_payroll_stream(p_category public.employee_category)
returns public.payroll_stream language sql immutable set search_path = public as $$
  select case when p_category = 'office_staff'
              then 'salaried'::public.payroll_stream
              else 'guard_field'::public.payroll_stream end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The run
-- ---------------------------------------------------------------------------

create table if not exists public.payroll_runs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  period_month date not null,
  stream       public.payroll_stream not null,
  -- Region scope: a run may cover one region or (null) the whole company for
  -- that stream. Batch totals still split by region either way.
  branch_id    uuid references public.branches(id),
  status       public.payroll_run_status not null default 'draft',
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  approved_by  uuid,
  approved_at  timestamptz,
  disbursed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at   timestamptz not null default now()
);

-- One live run per company/period/stream/region. A cancelled run frees the
-- slot so a period can be re-run after a mistake.
create unique index if not exists idx_payroll_run_unique
  on public.payroll_runs (company_id, period_month, stream,
                          coalesce(branch_id, '00000000-0000-0000-0000-000000000000'))
  where status <> 'cancelled';

create index if not exists idx_payroll_runs_company on public.payroll_runs(company_id, period_month);

alter table public.payslips
  add column if not exists payroll_run_id uuid references public.payroll_runs(id);
create index if not exists idx_payslips_run on public.payslips(payroll_run_id);

drop trigger if exists trg_aaa_payroll_run_fill_company on public.payroll_runs;
create trigger trg_aaa_payroll_run_fill_company
  before insert on public.payroll_runs
  for each row execute function public.fill_company_id();

alter table public.payroll_runs enable row level security;
drop policy if exists "ssa_all" on public.payroll_runs;
create policy "ssa_all" on public.payroll_runs for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.payroll_runs;
create policy "company_members" on public.payroll_runs for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 2. Who may approve (spec: COO/Finance sign-off)
-- ---------------------------------------------------------------------------

-- coalesce to false is load-bearing: current_role() is null when there is no
-- authenticated user, and `null in (...) or false` evaluates to NULL, not
-- false. `if not null` takes the else branch, which would let an unauthenticated
-- caller sail through the approval gate. Always return a hard boolean.
create or replace function public.is_payroll_approver()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    public.current_role()::text in ('super_super_admin', 'super_admin')
    or exists (
      select 1 from public.profiles
       where id = auth.uid() and 'payroll.approve' = any(permissions)),
    false);
$$;

-- ---------------------------------------------------------------------------
-- 3. The lock. Once a run is approved or beyond, the money figures on its
--    payslips are frozen. The ONLY change allowed is the disbursement flip
--    (disbursed / payment routing / status). This is what "approval locks the
--    run" means in practice.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_payroll_run_lock()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status public.payroll_run_status;
begin
  if new.payroll_run_id is null then return new; end if;

  select status into v_status from public.payroll_runs where id = new.payroll_run_id;
  if v_status is null or v_status in ('draft', 'review') then
    return new;  -- editable while not yet approved
  end if;

  -- Locked run: reject any change to a monetary / attendance figure.
  if new.base_salary   is distinct from old.base_salary
   or new.per_day_salary is distinct from old.per_day_salary
   or new.allowance    is distinct from old.allowance
   or new.bonus        is distinct from old.bonus
   or new.deductions   is distinct from old.deductions
   or new.advance      is distinct from old.advance
   or new.income_tax   is distinct from old.income_tax
   or new.eobi         is distinct from old.eobi
   or new.final_salary is distinct from old.final_salary
   or new.net_salary   is distinct from old.net_salary
   or new.working_days is distinct from old.working_days
   or new.present_days is distinct from old.present_days
   or new.absent_days  is distinct from old.absent_days
   or new.leave_days   is distinct from old.leave_days then
    raise exception 'payroll run is % and locked; payslip figures cannot change', v_status
      using errcode = '23514',
            hint = 'Reopen the run to draft/review before editing pay.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payslip_run_lock on public.payslips;
create trigger trg_payslip_run_lock
  before update on public.payslips
  for each row execute function public.enforce_payroll_run_lock();

-- ---------------------------------------------------------------------------
-- 4. Link a period's payslips to a run.
--
-- Generation stays where it is (the guard engine is unchanged per spec); this
-- bridges the payslips it produces to the run by matching period + stream +
-- region. Only unlinked payslips are claimed, and only while the run is a
-- draft.
-- ---------------------------------------------------------------------------

create or replace function public.payroll_run_attach(p_run_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_count integer;
begin
  select * into r from public.payroll_runs where id = p_run_id;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;
  if r.status <> 'draft' then
    raise exception 'can only attach payslips while the run is a draft' using errcode = '23514';
  end if;

  update public.payslips p
     set payroll_run_id = r.id, updated_at = now()
    from public.employees e
   where p.employee_id = e.id
     and p.company_id = r.company_id
     and p.period_month = r.period_month
     and p.payroll_run_id is null
     and public.employee_payroll_stream(e.category) = r.stream
     and (r.branch_id is null or p.branch_id = r.branch_id);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. State machine (non-disbursing transitions).
-- ---------------------------------------------------------------------------

create or replace function public.transition_payroll_run(
  p_run_id   uuid,
  p_to       public.payroll_run_status,
  p_reason   text default null
)
returns public.payroll_run_status language plpgsql security definer set search_path = public as $$
declare
  r        record;
  v_allowed boolean;
  v_count   integer;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;

  v_allowed := (r.status, p_to) in (
    ('draft',    'review'),
    ('review',   'draft'),
    ('review',   'approved'),
    ('approved', 'review'),      -- reopen before disbursing
    ('disbursed','completed'),
    ('draft',    'cancelled'),
    ('review',   'cancelled'),
    ('approved', 'cancelled')
  );
  if not v_allowed then
    raise exception 'illegal payroll run transition % -> %', r.status, p_to using errcode = '23514';
  end if;

  -- The gate: approval is a privileged, non-empty action.
  if p_to = 'approved' then
    if not coalesce(public.is_payroll_approver(), false) then
      raise exception 'only a payroll approver (COO/Finance) may approve a run'
        using errcode = '42501';
    end if;
    select count(*) into v_count from public.payslips where payroll_run_id = p_run_id;
    if v_count = 0 then
      raise exception 'cannot approve a run with no payslips' using errcode = '23514';
    end if;
  end if;

  update public.payroll_runs set
    status       = p_to,
    submitted_at = case when p_to = 'review'   then now() else submitted_at end,
    approved_by  = case when p_to = 'approved' then auth.uid()
                        when p_to = 'review'   then null else approved_by end,
    approved_at  = case when p_to = 'approved' then now()
                        when p_to = 'review'   then null else approved_at end,
    completed_at = case when p_to = 'completed' then now() else completed_at end,
    cancelled_at = case when p_to = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_to = 'cancelled' then p_reason else cancel_reason end,
    updated_at   = now()
  where id = p_run_id;

  return p_to;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Disburse: the one place that flips payslips to disbursed. Only an
--    approved run can be disbursed. Flipping disbursed fires the existing §4
--    journal trigger, so "Complete: journals posted" happens here by
--    construction.
-- ---------------------------------------------------------------------------

create or replace function public.disburse_payroll_run(p_run_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_count integer;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;
  if r.status <> 'approved' then
    raise exception 'payroll run must be approved before disbursement (currently %)', r.status
      using errcode = '23514';
  end if;

  update public.payroll_runs
     set status = 'disbursed', disbursed_at = now(), updated_at = now()
   where id = p_run_id;

  -- Flip the payslips. The lock trigger permits this (disbursed is not a money
  -- figure); the journal trigger posts each one.
  update public.payslips
     set disbursed = true,
         disbursed_at = coalesce(disbursed_at, now()),
         status = 'Cleared',
         updated_at = now()
   where payroll_run_id = p_run_id and not disbursed;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Batch totals at every stage, split by region (feeds regional P&L).
-- ---------------------------------------------------------------------------

create or replace view public.payroll_run_totals
  with (security_invoker = true) as
  select p.payroll_run_id,
         r.company_id,
         r.period_month,
         r.stream,
         r.status,
         p.branch_id,
         b.name as region_name,
         count(*)                                                  as payslip_count,
         sum(p.base_salary + p.allowance + p.bonus)               as gross,
         sum(p.deductions + p.advance + p.income_tax + p.eobi)    as total_deductions,
         sum(p.net_salary)                                        as net
    from public.payslips p
    join public.payroll_runs r on r.id = p.payroll_run_id
    left join public.branches b on b.id = p.branch_id
   group by p.payroll_run_id, r.company_id, r.period_month, r.stream, r.status,
            p.branch_id, b.name;

-- ---------------------------------------------------------------------------
-- 8. Review exceptions — the four the spec names, one row per flagged payslip.
--    Everything a reviewer must eyeball before approving, computed rather than
--    hunted for.
-- ---------------------------------------------------------------------------

create or replace view public.payroll_run_exceptions
  with (security_invoker = true) as
  select p.id            as payslip_id,
         p.payroll_run_id,
         p.company_id,
         p.employee_id,
         e.full_name,
         p.branch_id,
         p.net_salary,
         prev.net_salary as prev_net_salary,
         -- pay changed vs last month
         (prev.net_salary is not null and prev.net_salary <> p.net_salary) as pay_changed,
         -- joiner pro-rata: joined during this period
         (e.join_date is not null
            and e.join_date >= p.period_month
            and e.join_date < (p.period_month + interval '1 month')) as is_joiner,
         -- leaver settlement: exited during this period
         (e.exit_date is not null
            and e.exit_date >= p.period_month
            and e.exit_date < (p.period_month + interval '1 month')) as is_leaver,
         -- advance being netted this run
         (p.advance > 0) as has_advance_netting,
         p.advance
    from public.payslips p
    join public.employees e on e.id = p.employee_id
    left join public.payslips prev
           on prev.employee_id = p.employee_id
          and prev.period_month = (p.period_month - interval '1 month')::date
   where p.payroll_run_id is not null
     and (
       (prev.net_salary is not null and prev.net_salary <> p.net_salary)
       or (e.join_date is not null and e.join_date >= p.period_month
             and e.join_date < (p.period_month + interval '1 month'))
       or (e.exit_date is not null and e.exit_date >= p.period_month
             and e.exit_date < (p.period_month + interval '1 month'))
       or p.advance > 0
     );
