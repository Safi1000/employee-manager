-- 0224 — One attendance vocabulary, and the five predicates that were reading
--        the wrong half of it.
--
-- `attendance_records.status` carried two vocabularies at once: a legacy
-- capitalised set (Present/Absent/Leave) written by AttendanceManagement.tsx,
-- and the lowercase spec set (present/absent/double_duty/…) written by the
-- Attendance Board. The CHECK constraint whitelisted BOTH, so this was never
-- drift past a constraint — it was a constraint widened to admit two spellings
-- rather than pick one. Capitalised writes stopped on 2026-07-24; 19,793 live
-- rows remain.
--
-- Five case-sensitive comparisons were therefore reading roughly half the data:
--
--   avg_deployed_guards            saw 19,064 of 32,679 working rows
--   attendance_billing_suggestion  saw 13,347 of 32,411 present-days
--   accrue_attendance_bonuses      missed 223 lowercase absences (63 employees)
--   attendance_records_enforce_reliever  nulled the client on every lowercase mark
--   attendance_leave_history       correct only because no lowercase 'leave' existed
--
-- The money path was never affected: payslip_client_split, payroll_cost_by_client,
-- client_statement_loaded, attendance_payroll and record_separation all already
-- normalise with lower(). That is why the Part D ledger figures held.
--
-- avg_deployed_guards was the worst affected — its undercount is not uniform
-- across branches (ISB/RWP 61.7%, Kashmir 40.4%, Lahore 0.0%), so it does not
-- cancel in a ratio. It is corrected here but simultaneously DEPRECATED as a
-- cost driver: 0225 moves head-office apportionment onto revenue, because guard
-- days cannot apportion overhead to a services-only client that deploys nobody.
--
-- Scope note: this migration fixes CASING only. Narrowing the reliever trigger
-- to the genuinely non-working statuses, and backfilling the 60 live reliever
-- rows, is F2 and waits on the semantics of `blocked`. Head-office
-- apportionment is 0225.

-- ---------------------------------------------------------------------------
-- 1. The maintenance gate, under an honest name.
--
-- 0220 called this is_ledger_maintenance() because the journal was all it
-- guarded. It now also authorises this normalisation to edit rows sitting
-- behind the attendance locks, so the ledger-specific name no longer tells the
-- truth. Same gate, same session-variable, same role requirement.
-- ---------------------------------------------------------------------------

create or replace function public.is_maintenance_session()
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  -- session_user, NOT current_user: SECURITY DEFINER functions rewrite the
  -- latter, so an app role calling a definer function would otherwise pass.
  select coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
     and exists (select 1 from pg_roles
                  where rolname = session_user and (rolsuper or rolbypassrls));
$function$;

comment on function public.is_maintenance_session() is
  'Role-gated maintenance escape hatch. Requires app.ledger_maintenance = ''on'' AND a superuser/BYPASSRLS session_user. Renamed from is_ledger_maintenance() in 0224 — it now guards attendance locks as well as the journal.';

-- Repoint the one caller, then retire the old name so it cannot drift.
create or replace function public.enforce_journal_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if public.is_maintenance_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception
    'Posted journal rows are immutable. Reverse the entry instead, or run under a maintenance session.'
    using errcode = '23514';
end;
$function$;

drop function if exists public.is_ledger_maintenance();

-- ---------------------------------------------------------------------------
-- 2. Attendance locks honour the same gate.
--
-- The normalisation touches 1,739 live rows sitting behind three locks:
--   1,304  enforce_attendance_backfill service-window hard bound (no bypass
--          existed at all — app.skip_attendance_lock returns AFTER that check)
--     435  enforce_confirmed_month_end_lock
--     429  enforce_attendance_month_lock (OPS verification)
-- (union, not additive)
--
-- 0141 solved the same problem with `alter table ... disable trigger`, which
-- suspends the locks for every session and leaves no record of what it walked
-- past. A role-gated flag cannot be satisfied by an app role and pairs with the
-- audit trail written in step 3.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_attendance_month_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_emp uuid; v_date date; v_client uuid; v_cat text;
begin
  if public.is_maintenance_session() then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;
  if TG_OP = 'DELETE' then v_emp := OLD.employee_id; v_date := OLD.attendance_date;
  else v_emp := NEW.employee_id; v_date := NEW.attendance_date; end if;
  select client_id, category into v_client, v_cat from public.employees where id = v_emp;
  if v_client is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.client_id = v_client and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this client and locked. Un-verify it to edit attendance.';
    end if;
  elsif v_cat is not null then
    if exists (select 1 from public.attendance_month_verifications v
               where v.category = v_cat and v.period_month = date_trunc('month', v_date)::date) then
      raise exception 'This month is OPS-verified for this group and locked. Un-verify it to edit attendance.';
    end if;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end;
$function$;

create or replace function public.enforce_confirmed_month_end_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_emp uuid; v_date date; v_shift text; v_client uuid; v_cat text; v_override boolean;
begin
  if public.is_maintenance_session() then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  if TG_OP='DELETE' then
    v_emp:=OLD.employee_id; v_date:=OLD.attendance_date; v_shift:=OLD.worked_shift; v_override:=false;
  else
    v_emp:=NEW.employee_id; v_date:=NEW.attendance_date; v_shift:=NEW.worked_shift;
    v_override:=coalesce(NEW.supervisor_override,false);
  end if;
  if v_override then return case when TG_OP='DELETE' then OLD else NEW end; end if;
  if (date_trunc('month', v_date) + interval '1 month')::date > current_date then
    return case when TG_OP='DELETE' then OLD else NEW end;
  end if;
  select client_id, category into v_client, v_cat from public.employees where id=v_emp;
  if exists (
    select 1 from public.attendance_confirmations c
    where c.attendance_date=v_date and c.shift_code=v_shift
      and ((v_client is not null and c.client_id=v_client)
           or (v_client is null and v_cat is not null and c.category=v_cat))
  ) then
    raise exception 'This shift is confirmed and the month has ended — locked. Edit it via Override on the Monthly Board.';
  end if;
  return case when TG_OP='DELETE' then OLD else NEW end;
end;
$function$;

create or replace function public.enforce_attendance_backfill()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  e  record;
  lb date;
  ub date;
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  -- An UPDATE that doesn't change the status isn't a (re)mark; let it pass.
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;

  select em.join_date, em.exit_date, c.start_date as c_start, c.end_date as c_end
    into e
    from public.employees em
    left join public.contracts c on c.id = em.contract_id
   where em.id = new.employee_id;

  lb := greatest(e.join_date, e.c_start);
  ub := least(e.c_end, e.exit_date);

  if lb is not null and new.attendance_date < lb then
    raise exception
      'attendance for % is before this guard''s service window (starts %)', new.attendance_date, lb
      using errcode = '23514';
  end if;
  if ub is not null and new.attendance_date > ub then
    raise exception
      'attendance for % is after this guard''s service window (ends %)', new.attendance_date, ub
      using errcode = '23514';
  end if;

  if coalesce(current_setting('app.skip_attendance_lock', true), '') = '1' then
    return new;
  end if;

  if public.is_attendance_locked(new.company_id, new.attendance_date)
     and not public.has_perm('attendance.backdate') then
    raise exception
      'backdating attendance to % requires the Backdate Attendance permission', new.attendance_date
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

-- The reliever trigger is bypassed too, so the relabel cannot null a client on
-- its way past. The 57 live reliever rows are already NULL and stay that way
-- for F2 to backfill; bypassing here also stops the post-normalisation
-- `raise` from aborting the migration on those exact rows.
create or replace function public.attendance_records_enforce_reliever()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  emp_category text;
  emp_client   uuid;
  v_client     uuid;
begin
  if public.is_maintenance_session() then
    return new;
  end if;

  select category::text, client_id into emp_category, emp_client
    from public.employees
   where id = new.employee_id;

  if emp_category = 'reliever' then
    -- Casing fix only. Narrowing this to the genuinely non-working statuses
    -- (so relief_cover and double_duty carry the covered client) is F2 and
    -- waits on what `blocked` means operationally.
    if lower(new.status) = 'present' and new.worked_for_client_id is null then
      raise exception 'Relievers marked present must record worked_for_client_id'
        using errcode = '23514';
    end if;
    if lower(new.status) <> 'present' then
      new.worked_for_client_id := null;
    end if;
  else
    v_client := public.deployment_client_on(new.employee_id, new.attendance_date);
    new.worked_for_client_id := coalesce(v_client, emp_client);
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Audit trail, then the relabel.
--
-- A one-time edit of ~23,000 rows that walks past three locks has to leave
-- something an auditor can read afterwards. Every changed row gets an audit_log
-- entry recording its old and new token before the update runs.
-- ---------------------------------------------------------------------------

do $$
declare
  v_present int; v_absent int; v_leave int; v_rot int; v_logged int;
begin
  perform set_config('app.ledger_maintenance', 'on', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  select a.company_id, 'attendance_records', a.id, 'update', null,
         jsonb_build_object(
           'migration', '0224_attendance_status_normalisation',
           'field',     'status',
           'from',      a.status,
           'to',        case when a.status = 'rotation_leave' then 'leave' else lower(a.status) end)
    from public.attendance_records a
   where a.status <> case when a.status = 'rotation_leave' then 'leave' else lower(a.status) end;
  get diagnostics v_logged = row_count;

  select count(*) filter (where status = 'Present'),
         count(*) filter (where status = 'Absent'),
         count(*) filter (where status = 'Leave'),
         count(*) filter (where status = 'rotation_leave')
    into v_present, v_absent, v_leave, v_rot
    from public.attendance_records;

  -- The old CHECK whitelists both vocabularies and forbids 'leave'; it has to
  -- come off before the relabel and go back on narrowed.
  alter table public.attendance_records drop constraint if exists attendance_records_status_check;

  -- rotation_leave folds into leave: attendance_payroll has always bucketed
  -- ('leave','rotation_leave','rest_day') identically, and 0141 already made
  -- this exact argument. 0141 converted the data but never stopped the writers,
  -- which is why 113 rotation_leave rows exist that POSTDATE it.
  update public.attendance_records
     set status = case when status = 'rotation_leave' then 'leave' else lower(status) end
   where status <> case when status = 'rotation_leave' then 'leave' else lower(status) end;

  alter table public.attendance_records
    add constraint attendance_records_status_check
    check (status in ('present','absent','leave','rest_day','double_duty','relief_cover','blocked'));

  raise notice '0224 normalised: Present=% Absent=% Leave=% rotation_leave=% (audit rows logged: %)',
    v_present, v_absent, v_leave, v_rot, v_logged;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The five predicates.
--
-- All use lower(), matching the convention the money-path functions already
-- follow. After step 3 only lowercase exists, so lower() is belt-and-braces —
-- but it is the convention that stops this recurring.
-- ---------------------------------------------------------------------------

-- DEPRECATED as an allocation driver — see 0225, which moves head-office
-- apportionment onto revenue per A10. Head office cost is apportioned by what a
-- region BILLS, never by guard-days: a services-only client with no deployment
-- would otherwise absorb no overhead at all.
--
-- Kept, with its predicate corrected, because it remains a valid headcount /
-- capacity measure and because the database carries migrations (0109-0112) that
-- are absent from this repo, so "no caller" cannot be proven from the repo alone.
create or replace function public.avg_deployed_guards(
  p_company_id uuid, p_branch_id uuid, p_period date)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select round(
    count(*) filter (where lower(a.status) in ('present','double_duty','relief_cover'))::numeric
    / extract(day from (date_trunc('month', p_period) + interval '1 month - 1 day')), 2)
  from public.attendance_records a
  where a.company_id = p_company_id
    and a.branch_id = p_branch_id
    and a.attendance_date >= date_trunc('month', p_period)::date
    and a.attendance_date < (date_trunc('month', p_period) + interval '1 month')::date;
$function$;

comment on function public.avg_deployed_guards(uuid, uuid, date) is
  'Average guards deployed in a branch-month. DEPRECATED as a cost-allocation driver (0225 moved HO apportionment to revenue per A10); retained as a headcount/capacity measure.';

-- Display-only calculator behind the Receivables > Billing "Compute" button.
-- No invoice derives from it, so nothing was ever under-billed — but it would
-- mislead whoever pressed the button.
--
-- NOTE: this counts plain 'present' only, where every other money-path function
-- counts ('present','double_duty','relief_cover'). Left as-is: widening it is a
-- billing-policy change, not a casing fix. Flagged for decision.
-- Dropped rather than replaced: the OUT parameter names differ from the
-- original, and CREATE OR REPLACE cannot change a function's row type.
drop function if exists public.attendance_billing_suggestion(uuid, date, date);
create or replace function public.attendance_billing_suggestion(
  p_client_id uuid, p_period_start date, p_period_end date)
returns table(guard_days int, standard_days int, contract_rate numeric, suggested numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with days as (select (p_period_end - p_period_start + 1)::int as std),
  present as (
    select count(*)::int as gd from public.attendance_records a
     where a.worked_for_client_id = p_client_id
       and a.attendance_date between p_period_start and p_period_end
       and lower(a.status) = 'present'
  ),
  rate as (
    select coalesce(max(ct.rate_per_guard_per_month), 0) as r from public.contracts ct
     where ct.client_id = p_client_id and coalesce(ct.status::text,'active') = 'active'
  )
  select present.gd, days.std, rate.r,
         round(rate.r * present.gd / nullif(days.std,0), 2)
    from present, days, rate;
$function$;

-- Disqualification missed lowercase absences, leaving 63 employees who WERE
-- absent still eligible for the attendance bonus.
create or replace function public.accrue_attendance_bonuses(
  p_company_id uuid, p_period date, p_amount numeric)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_start date := v_month;
  v_end   date := (v_month + interval '1 month - 1 day')::date;
  v_count integer;
begin
  with qualifying as (
    select e.id as employee_id, e.company_id
      from public.employees e
     where e.company_id = p_company_id
       and e.category in ('client', 'reliever')
       and e.lifecycle_state = 'active'
       and exists (select 1 from public.attendance_records a
                    where a.employee_id = e.id
                      and a.attendance_date between v_start and v_end)
       and not exists (select 1 from public.attendance_records a
                        where a.employee_id = e.id
                          and a.attendance_date between v_start and v_end
                          and lower(a.status) = 'absent')
  )
  insert into public.guard_bonuses (company_id, employee_id, bonus_type, period_month, amount)
  select company_id, employee_id, 'attendance', v_month, p_amount from qualifying
  on conflict (employee_id, bonus_type, period_month) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

-- Correct today only because no lowercase 'leave' row existed. Now that 'leave'
-- IS the canonical token, the old predicate would have returned nothing at all.
drop function if exists public.attendance_leave_history(date, date);
create or replace function public.attendance_leave_history(
  p_window_start date, p_until date)
returns table(employee_id uuid, month_key text, cnt int)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select employee_id,
         to_char(date_trunc('month', attendance_date), 'YYYY-MM-DD') as month_key,
         count(*)::int as cnt
  from public.attendance_records
  where lower(status) in ('leave', 'rotation_leave', 'rest_day')
    and attendance_date >= p_window_start
    and attendance_date < p_until
  group by employee_id, date_trunc('month', attendance_date)
$function$;

