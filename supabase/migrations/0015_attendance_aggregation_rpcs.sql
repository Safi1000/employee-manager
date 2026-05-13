-- ============================================================================
-- Server-side aggregation RPCs for attendance. Bypasses PostgREST's default
-- ~1000-row response cap that was silently dropping attendance for most
-- employees on companies with 30+ employees × full month coverage.
-- security invoker = caller's RLS applies (so the same per-company scoping).
-- ============================================================================

create or replace function public.attendance_period_counts(p_start date, p_end date)
returns table (
  employee_id uuid,
  status text,
  cnt integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select employee_id, status::text, count(*)::int
  from public.attendance_records
  where attendance_date >= p_start
    and attendance_date <= p_end
  group by employee_id, status
$$;

create or replace function public.attendance_leave_history(p_window_start date, p_until date)
returns table (
  employee_id uuid,
  month_key text,
  cnt integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select employee_id,
         to_char(date_trunc('month', attendance_date), 'YYYY-MM-DD') as month_key,
         count(*)::int as cnt
  from public.attendance_records
  where status = 'Leave'
    and attendance_date >= p_window_start
    and attendance_date < p_until
  group by employee_id, date_trunc('month', attendance_date)
$$;

grant execute on function public.attendance_period_counts(date, date) to authenticated;
grant execute on function public.attendance_leave_history(date, date) to authenticated;
