-- Attendance marked on or after an employee's separation.
--
-- READ ONLY. Nothing here writes. Run it in the Supabase SQL editor.
--
-- ── FINDINGS, run against production 2026-08-13 ─────────────────────────────
-- 133 rows / 25 people, 2026-04-01 → 2026-08-09. 116 carry a paid status.
--
-- Almost all of it is BACKDATED SEPARATION DATES, not bad attendance:
--   • 110 of the 116 were marked BEFORE the separation was ever recorded in the
--     system. The guard stopped turning up, attendance kept being marked, and
--     HR entered the separation weeks later with a retrospective effective date.
--   • Separations are recorded a median of weeks after they take effect; the
--     worst is 223 days. One (Qamar Zaman, GGS-00381, PFM) was recorded
--     2026-07-31 with an effective date of 2026-01-01 and the note "off" — a
--     placeholder. He has complete, coherent April and May attendance and two
--     normally-disbursed payslips. His PAY is right; his separation DATE is wrong.
--   • 16 of the marks fall exactly on the employee's own last_working_day.
--
-- Money actually disbursed on the strength of these rows: PKR 45,123, all of it
-- the Qamar Zaman record above, and it appears to be legitimately earned.
-- Everything in July and August has NO payslip yet — still correctable.
--
-- After excluding last-working-day marks and separations backdated more than 30
-- days, what is genuinely unexplained is 51 marks across 13 people, worth about
-- PKR 37,803 — none of it paid out.
--
-- No evidence of fabricated attendance was found.
-- WHY THIS MATTERS
--
-- attendance_payroll() (migrations/0173) computes pay straight off
-- attendance_records with no employment-window filter at all:
--
--     from public.attendance_records ar
--     where ar.attendance_date between p_start and p_end
--
--     earned = sum(rate / days_in_month) for status in
--              ('present','double_duty','relief_cover')
--
-- and PayrollManagement.tsx deliberately keys the payroll list on attendance
-- rather than on separation, so that a guard who worked half a month before
-- leaving still appears and still gets paid. That is correct behaviour — but it
-- means a WRONG attendance row after separation is indistinguishable from a
-- right one, and pays out.
--
-- The UI-side guard (hiddenFromAttendance in lib/employmentWindow.ts) stops new
-- marks being made and hides these rows from the board and the exports. It does
-- not delete what is already there, and it is not applied by payroll at all.
--
-- The cutoff ladder matches lib/employmentWindow.ts exactly:
--     coalesce(termination_date, last_working_day, exit_date)
-- with the row counted when attendance_date >= cutoff. termination_date comes
-- first because it is the date the separation took EFFECT and is not markable;
-- last_working_day is the final day actually worked and IS markable.

-- ── 1. Headline: how many, and do they cost money? ──────────────────────────
with sep as (
  select e.id,
         e.full_name,
         e.lifecycle_state,
         coalesce(e.termination_date, e.last_working_day, e.exit_date) as cutoff
    from public.employees e
   where coalesce(e.termination_date, e.last_working_day, e.exit_date) is not null
),
bad as (
  select ar.id, ar.employee_id, ar.attendance_date, lower(ar.status) as status,
         s.full_name, s.lifecycle_state, s.cutoff
    from public.attendance_records ar
    join sep s on s.id = ar.employee_id
   where ar.attendance_date >= s.cutoff
)
select count(*)                                                        as rows_total,
       count(*) filter (where status in ('present','double_duty','relief_cover'))
                                                                       as rows_that_earn_pay,
       count(*) filter (where status = 'absent')                       as rows_absent,
       count(*) filter (where status in ('leave','rotation_leave','rest_day'))
                                                                       as rows_leave,
       count(distinct employee_id)                                     as people_affected,
       min(attendance_date)                                            as earliest,
       max(attendance_date)                                            as latest
  from bad;

-- ── 2. The money. Same rate maths attendance_payroll uses. ──────────────────
-- Only paid statuses. This is what was (or would be) added to a payslip for
-- days after the person had already left.
with sep as (
  select e.id, e.full_name,
         coalesce(e.termination_date, e.last_working_day, e.exit_date) as cutoff
    from public.employees e
   where coalesce(e.termination_date, e.last_working_day, e.exit_date) is not null
)
select s.full_name,
       s.cutoff                                        as separated_effective,
       count(*)                                        as paid_days_after,
       min(ar.attendance_date)                         as first_bad_mark,
       max(ar.attendance_date)                         as last_bad_mark,
       round(sum(
         coalesce(
           (select sh.base_salary from public.employee_salary_history sh
             where sh.employee_id = ar.employee_id
               and sh.effective_date <= ar.attendance_date
             order by sh.effective_date desc limit 1),
           (select e2.base_salary from public.employees e2 where e2.id = ar.employee_id),
           0)
         / nullif(extract(day from (date_trunc('month', ar.attendance_date)
                                    + interval '1 month - 1 day'))::int, 0)
       ), 0)                                           as approx_overpaid
  from public.attendance_records ar
  join sep s on s.id = ar.employee_id
 where ar.attendance_date >= s.cutoff
   and lower(ar.status) in ('present','double_duty','relief_cover')
 group by s.full_name, s.cutoff
 order by approx_overpaid desc;

-- ── 3. Has it already been paid out? ────────────────────────────────────────
-- A row in a period with a DISBURSED payslip is money that has left the
-- building; one in an open period is still correctable before it does.
-- payslips.period_month is a DATE pinned to the 1st (see migrations/0001).
with sep as (
  select e.id,
         coalesce(e.termination_date, e.last_working_day, e.exit_date) as cutoff
    from public.employees e
   where coalesce(e.termination_date, e.last_working_day, e.exit_date) is not null
)
select to_char(ar.attendance_date, 'YYYY-MM')          as month,
       count(*)                                        as bad_marks,
       count(distinct ar.employee_id)                  as people,
       bool_or(coalesce(p.disbursed, false))           as any_payslip_disbursed
  from public.attendance_records ar
  join sep s on s.id = ar.employee_id
  left join public.payslips p
         on p.employee_id = ar.employee_id
        and p.period_month = date_trunc('month', ar.attendance_date)::date
 where ar.attendance_date >= s.cutoff
   and lower(ar.status) in ('present','double_duty','relief_cover')
 group by 1
 order by 1;

-- ── 4. Who marked them, and when? ───────────────────────────────────────────
-- Separates "keyed in before the separation was recorded" (ordinary, forgivable)
-- from "keyed in after we already knew the man had left" (needs a conversation).
with sep as (
  select e.id, e.full_name,
         coalesce(e.termination_date, e.last_working_day, e.exit_date) as cutoff
    from public.employees e
   where coalesce(e.termination_date, e.last_working_day, e.exit_date) is not null
)
select s.full_name,
       ar.attendance_date,
       ar.status,
       ar.created_at                                   as marked_at,
       (ar.created_at::date > s.cutoff)                as marked_after_they_left
  from public.attendance_records ar
  join sep s on s.id = ar.employee_id
 where ar.attendance_date >= s.cutoff
 order by ar.created_at desc;
