-- 0156: freeze the shift on every posting that never recorded one.
--
-- shift is meant to be a DATED property of the posting (0130), but postings
-- created before deployments.shift_code existed — and those created by
-- Assignments & Pay before it started stamping the column — left it null.
-- loadShiftResolver falls a null shift_code through to the guard's CURRENT
-- shift, so the first shift change repaints every earlier day with the new
-- shift (the bug fixed for exports in ab6437e, re-entering through the data).
--
-- Precedence matches 0130's original backfill: the posting's contract line where
-- it declares a shift, else the guard's current shift. The contract header's
-- day/night/evening columns are aggregate COUNTS — they say how many guards work
-- each shift, never which guard — so they cannot drive this.
--
-- Writes exactly what the resolver already computes today: nothing on screen
-- changes, the value simply stops moving later.
update public.deployments d
set shift_code = coalesce(
      (select cl.shift_code::text
         from public.contract_lines cl
        where cl.id = d.contract_line_id and cl.shift_code is not null),
      e.shift,
      'day'),
    updated_at = now()
from public.employees e
where e.id = d.guard_id
  and d.shift_code is null;
