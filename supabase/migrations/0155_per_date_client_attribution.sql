-- ---------------------------------------------------------------------------
-- 0155 — Attendance is attributed to the client the guard actually worked for
--        ON THAT DATE, so a mid-month transfer splits across both clients.
--
-- The problem
-- -----------
-- A guard posted to Client A 1–22 Jul and Client B 23–31 Jul had their whole
-- month charged to one client, two different ways:
--
--   1. attendance_records.worked_for_client_id was force-NULLed for every
--      non-reliever by the 0030 trigger ("their cost goes to
--      employees.client_id"). Every attendance row in the system carried no
--      client — so attendance_billable_quantity() and
--      v_client_billing_reconciliation, which both filter on that column,
--      returned zero for every client.
--   2. employees.client_id is a single undated field, so it can only ever name
--      the CURRENT client. A transfer silently moved the guard's entire history
--      to the new client.
--
-- The dated posting segments in public.deployments already model transfers
-- correctly. This migration makes them the source of attribution.
--
-- Overlaps: a few guards have two open postings to different clients at once.
-- The resolver takes the latest-starting one, so a segment that begins on the
-- transfer date wins the day it starts.
-- ---------------------------------------------------------------------------

-- 1. Which client was this guard posted to on this date?
create or replace function public.deployment_client_on(p_guard uuid, p_date date)
returns uuid
language sql stable security definer set search_path = public as $$
  select d.client_id
    from public.deployments d
   where d.guard_id = p_guard
     and d.client_id is not null
     and d.start_date <= p_date
     and (d.end_date is null or d.end_date >= p_date)
   order by d.start_date desc, d.created_at desc
   limit 1;
$$;

grant execute on function public.deployment_client_on(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Replace the 0030 trigger. Relievers keep their explicit per-day choice
--    (the operator picks the client, and it stays required). Everyone else now
--    DERIVES the client from the posting covering that date instead of being
--    blanked — falling back to employees.client_id when the guard has no
--    posting for the date, so nothing regresses for un-posted staff.
--
--    Deriving here rather than in each screen means every write path is
--    correct by construction: the daily board, "Mark All Present", the
--    timesheet corrections and the bulk-mark calendar all land right, and a
--    backdated correction is attributed to the client of THAT date, not to
--    whoever the guard is posted to today.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_records_enforce_reliever()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  emp_category text;
  emp_client   uuid;
  v_client     uuid;
begin
  select category::text, client_id into emp_category, emp_client
    from public.employees
   where id = new.employee_id;

  if emp_category = 'reliever' then
    if new.status = 'Present' and new.worked_for_client_id is null then
      raise exception 'Relievers marked Present must record worked_for_client_id'
        using errcode = '23514';
    end if;
    if new.status <> 'Present' then
      new.worked_for_client_id := null;
    end if;
  else
    v_client := public.deployment_client_on(new.employee_id, new.attendance_date);
    new.worked_for_client_id := coalesce(v_client, emp_client);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. client_shift_roster returned e.client_id (the guard's CURRENT client)
--    while selecting the guard through the dated posting. Marking a backdated
--    day therefore stamped today's client. Return the posting's client.
-- ---------------------------------------------------------------------------
create or replace function public.client_shift_roster(p_site uuid, p_shift text, p_date date)
returns table (guard_id uuid, full_name text, guard_code text, display_number int,
               employee_code text, client_id uuid, scheduled_shift text)
language sql stable security definer set search_path = public as $$
  select e.id, e.full_name, e.guard_code, e.display_number, e.employee_code,
         coalesce(d.client_id, e.client_id) as client_id,
         coalesce(cl.shift_code::text, e.shift) as scheduled_shift
  from public.deployments d
  join public.employees e on e.id = d.guard_id
  left join public.contract_lines cl on cl.id = d.contract_line_id
  where d.site_id = p_site
    and d.start_date <= p_date
    and (d.end_date is null or d.end_date >= p_date)
    and (e.join_date is null or e.join_date <= p_date)
    and (e.last_working_day is null or e.last_working_day >= p_date)
    and e.lifecycle_state <> 'archived'
    and coalesce(cl.shift_code::text, e.shift) = p_shift;
$$;

grant execute on function public.client_shift_roster(uuid, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Per-client payroll cost for a period, split by the days actually worked
--    for each client. This is what makes a mid-month transfer land 22 days on
--    Client A and 9 on Client B instead of the whole salary on one.
--
--    A payslip with no attributable worked days (nothing marked) falls back
--    whole to the guard's current client, which is the old behaviour — better
--    than dropping the cost out of the report entirely.
-- ---------------------------------------------------------------------------
create or replace function public.payroll_cost_by_client(p_period_month date)
returns table (client_id uuid, cost numeric)
language sql stable security definer set search_path = public as $$
  with ps as (
    select p.employee_id,
           sum(p.final_salary)::numeric as salary,
           e.client_id                  as fallback_client
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.period_month = p_period_month
     group by p.employee_id, e.client_id
  ),
  days as (
    select a.employee_id,
           coalesce(a.worked_for_client_id, ps.fallback_client) as cid,
           count(*)::numeric as d
      from public.attendance_records a
      join ps on ps.employee_id = a.employee_id
     where a.attendance_date >= p_period_month
       and a.attendance_date < (p_period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1, 2
  ),
  totals as (
    select employee_id, sum(d) as total_d from days group by 1
  ),
  split as (
    -- Proportional share of the payslip per client, by worked days.
    select days.cid as client_id,
           ps.salary * days.d / nullif(totals.total_d, 0) as cost
      from days
      join totals on totals.employee_id = days.employee_id
      join ps     on ps.employee_id     = days.employee_id
    union all
    -- Nothing worked/marked → whole salary to the current client (old behaviour).
    select ps.fallback_client, ps.salary
      from ps
     where not exists (
       select 1 from totals t
        where t.employee_id = ps.employee_id and t.total_d > 0
     )
  )
  select client_id, round(sum(cost), 2) as cost
    from split
   where client_id is not null
   group by client_id;
$$;

grant execute on function public.payroll_cost_by_client(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill every historical attendance row from the dated postings.
--    Relievers are skipped — theirs was always recorded explicitly and is
--    already correct.
--
--    Note: this fires the 0075 region trigger (it watches worked_for_client_id),
--    so a row's branch_id is re-derived from the client's region. That is the
--    intended tagging; it only changes rows where the guard's own region and
--    their client's region differ.
-- ---------------------------------------------------------------------------
update public.attendance_records a
   set worked_for_client_id =
         coalesce(public.deployment_client_on(a.employee_id, a.attendance_date), e.client_id)
  from public.employees e
 where e.id = a.employee_id
   and e.category::text <> 'reliever'
   and a.worked_for_client_id is null;
