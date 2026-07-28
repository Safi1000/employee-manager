-- 0139: Correct overlapping deployment segments so per-date shift is unambiguous.
--
-- A few historical shift changes opened a new posting segment WITHOUT closing the
-- prior one (change_guard_shift closes at effective-1, but some segments were
-- later re-extended by separation/rehire edits), leaving a guard with two
-- overlapping segments on DIFFERENT shifts for the same dates. shiftOnDate reads
-- the dated segment covering a date, so an overlap makes day/night ambiguous.
--
-- Fix: close each segment the day BEFORE its successor starts. Only affects
-- segments that (a) have a later-starting successor and (b) currently overlap it.
-- end_date only SHRINKS (never extends), never goes before start_date, and
-- attendance_records are NOT touched — only the shift a date is DISPLAYED under
-- changes. Same-day double postings (successor starts the same day) are left
-- alone: a same-day day+night is legitimate double duty, not an overlap to close.
--
-- Idempotent: re-running is a no-op once segments no longer overlap.

with ordered as (
  select d.id,
         lead(d.start_date) over (
           partition by d.guard_id order by d.start_date, d.id
         ) as next_start
  from public.deployments d
)
update public.deployments t
set end_date   = o.next_start - 1,
    updated_at = now()
from ordered o
where t.id = o.id
  and o.next_start is not null
  and o.next_start > t.start_date                       -- different day, real overlap
  and (t.end_date is null or t.end_date >= o.next_start); -- currently overlaps successor
