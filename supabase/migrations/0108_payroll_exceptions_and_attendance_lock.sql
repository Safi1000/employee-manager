-- Payroll exceptions + attendance backfill lock (spec section 28).
--
-- The defect §28 is built around: unmarked attendance days silently earn zero
-- and flow into near-zero payslips that one-click disbursement would pay. This
-- makes unmarked days a first-class figure, turns the payroll run's exceptions
-- into an approval GATE, logs bonus/deduction edits as reasoned adjustments,
-- and locks attendance after a cutoff so backfilling requires a reason.

-- ===========================================================================
-- 1. Unmarked days on the payslip (working − present − absent − leave).
-- ===========================================================================

alter table public.payslips
  add column if not exists unmarked_days integer not null default 0;

-- Backfill from the figures already stored.
update public.payslips
   set unmarked_days = greatest(working_days - present_days - absent_days - leave_days, 0)
 where unmarked_days = 0;

-- ===========================================================================
-- 2. Adjustment lines: bonus/deduction edits require a reason and are logged.
-- ===========================================================================

do $$ begin
  create type public.payslip_adjustment_kind as enum ('bonus', 'deduction');
exception when duplicate_object then null; end $$;

create table if not exists public.payslip_adjustments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  payslip_id   uuid not null references public.payslips(id) on delete cascade,
  kind         public.payslip_adjustment_kind not null,
  amount       numeric(16,2) not null,
  reason       text not null,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

create index if not exists idx_padj_payslip on public.payslip_adjustments(payslip_id);

drop trigger if exists trg_aaa_padj_fill_company on public.payslip_adjustments;
create trigger trg_aaa_padj_fill_company
  before insert on public.payslip_adjustments
  for each row execute function public.fill_company_id();

alter table public.payslip_adjustments enable row level security;
drop policy if exists "ssa_all" on public.payslip_adjustments;
create policy "ssa_all" on public.payslip_adjustments for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.payslip_adjustments;
create policy "company_members" on public.payslip_adjustments for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ===========================================================================
-- 3. Exception acknowledgements + richer exceptions view (the seven §28.1
--    flags, one row per flagged payslip). The ack table is defined first
--    because the view joins it.
-- ===========================================================================

create table if not exists public.payroll_run_exception_acks (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  payslip_id     uuid not null references public.payslips(id) on delete cascade,
  reason         text not null,
  acknowledged_by uuid,
  acknowledged_at timestamptz not null default now(),
  unique (payslip_id)
);

drop trigger if exists trg_aaa_prea_fill_company on public.payroll_run_exception_acks;
create trigger trg_aaa_prea_fill_company
  before insert on public.payroll_run_exception_acks
  for each row execute function public.fill_company_id();

alter table public.payroll_run_exception_acks enable row level security;
drop policy if exists "ssa_all" on public.payroll_run_exception_acks;
create policy "ssa_all" on public.payroll_run_exception_acks for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.payroll_run_exception_acks;
create policy "company_members" on public.payroll_run_exception_acks for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Reshaping the 0085 view (new columns) — replace can't reorder, so drop first.
drop view if exists public.payroll_run_exceptions;
create view public.payroll_run_exceptions
  with (security_invoker = true) as
  select p.id            as payslip_id,
         p.payroll_run_id,
         p.company_id,
         p.employee_id,
         e.full_name,
         p.branch_id,
         p.net_salary,
         p.unmarked_days,
         prev.net_salary as prev_net_salary,
         -- the flags
         (p.unmarked_days > 0)                                             as has_unmarked,
         (p.working_days > 0
            and p.present_days::numeric / p.working_days < 0.5)            as low_attendance,
         (coalesce(p.net_salary, 0) <= 0)                                  as zero_value,
         (prev.net_salary is not null and prev.net_salary <> p.net_salary) as pay_changed,
         (e.join_date is not null and e.join_date >= p.period_month
            and e.join_date < (p.period_month + interval '1 month'))       as is_joiner,
         (e.exit_date is not null and e.exit_date >= p.period_month
            and e.exit_date < (p.period_month + interval '1 month'))       as is_leaver,
         (p.advance > 0)                                                   as has_advance_netting,
         (ack.id is not null)                                              as acknowledged,
         ack.reason as ack_reason
    from public.payslips p
    join public.employees e on e.id = p.employee_id
    left join public.payslips prev
           on prev.employee_id = p.employee_id
          and prev.period_month = (p.period_month - interval '1 month')::date
    left join public.payroll_run_exception_acks ack on ack.payslip_id = p.id
   where p.payroll_run_id is not null
     and (
       p.unmarked_days > 0
       or (p.working_days > 0 and p.present_days::numeric / p.working_days < 0.5)
       or coalesce(p.net_salary, 0) <= 0
       or (prev.net_salary is not null and prev.net_salary <> p.net_salary)
       or (e.join_date is not null and e.join_date >= p.period_month
             and e.join_date < (p.period_month + interval '1 month'))
       or (e.exit_date is not null and e.exit_date >= p.period_month
             and e.exit_date < (p.period_month + interval '1 month'))
       or p.advance > 0
     );

-- Acknowledge a payslip's exceptions with a reason.
create or replace function public.acknowledge_payroll_exception(
  p_payslip_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'acknowledging an exception requires a reason' using errcode = '23514';
  end if;
  select company_id, payroll_run_id into r from public.payslips where id = p_payslip_id;
  if r.payroll_run_id is null then
    raise exception 'payslip is not attached to a run' using errcode = '23514';
  end if;
  insert into public.payroll_run_exception_acks
    (company_id, payroll_run_id, payslip_id, reason, acknowledged_by)
  values (r.company_id, r.payroll_run_id, p_payslip_id, p_reason, auth.uid())
  on conflict (payslip_id) do update set reason = excluded.reason,
    acknowledged_by = excluded.acknowledged_by, acknowledged_at = now();
end;
$$;

-- Count of a run's still-unacknowledged exception payslips.
create or replace function public.run_unacked_exception_count(p_run_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.payroll_run_exceptions
   where payroll_run_id = p_run_id and not acknowledged;
$$;

-- ===========================================================================
-- 4. Gate: a run cannot reach Approved with unacknowledged exceptions.
--    Body identical to 0085 apart from the added exception check.
-- ===========================================================================

create or replace function public.transition_payroll_run(
  p_run_id   uuid,
  p_to       public.payroll_run_status,
  p_reason   text default null
)
returns public.payroll_run_status language plpgsql security definer set search_path = public as $$
declare
  r         record;
  v_allowed boolean;
  v_count   integer;
  v_unacked integer;
begin
  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;

  v_allowed := (r.status, p_to) in (
    ('draft',    'review'),
    ('review',   'draft'),
    ('review',   'approved'),
    ('approved', 'review'),
    ('disbursed','completed'),
    ('draft',    'cancelled'),
    ('review',   'cancelled'),
    ('approved', 'cancelled')
  );
  if not v_allowed then
    raise exception 'illegal payroll run transition % -> %', r.status, p_to using errcode = '23514';
  end if;

  if p_to = 'approved' then
    if not coalesce(public.is_payroll_approver(), false) then
      raise exception 'only a payroll approver (COO/Finance) may approve a run'
        using errcode = '42501';
    end if;
    select count(*) into v_count from public.payslips where payroll_run_id = p_run_id;
    if v_count = 0 then
      raise exception 'cannot approve a run with no payslips' using errcode = '23514';
    end if;
    v_unacked := public.run_unacked_exception_count(p_run_id);
    if v_unacked > 0 then
      raise exception 'run has % unacknowledged exception(s); resolve or accept each before approval', v_unacked
        using errcode = '23514';
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

-- ===========================================================================
-- 5. Attendance backfill lock (spec §28.2): after the cutoff, marking a past
--    day requires a supervisor reason — the discipline that makes attendance
--    trustworthy to bill from.
-- ===========================================================================

alter table public.field_ops_settings
  add column if not exists attendance_backfill_lock_days integer not null default 1;

alter table public.attendance_records
  add column if not exists backfill_reason text,
  add column if not exists backfilled_by   uuid;

create or replace function public.is_attendance_locked(p_company_id uuid, p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select p_date < current_date - coalesce(
    (select attendance_backfill_lock_days from public.field_ops_settings where company_id = p_company_id), 1);
$$;

-- A late mark (insert or a status change) on a locked date needs a reason. A
-- bulk historical import can set app.skip_attendance_lock to bypass.
create or replace function public.enforce_attendance_backfill()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.skip_attendance_lock', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;  -- not a (re)mark
  end if;
  if public.is_attendance_locked(new.company_id, new.attendance_date)
     and coalesce(trim(new.backfill_reason), '') = '' then
    raise exception 'attendance for % is past the marking cutoff; a supervisor backfill reason is required',
      new.attendance_date using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_attendance_backfill_lock on public.attendance_records;
create trigger trg_attendance_backfill_lock
  before insert or update on public.attendance_records
  for each row execute function public.enforce_attendance_backfill();
