-- 0127: Phase 6 corrective — widen attendance status CHECK to the §8.3 set.
--
-- 0126's board writes the spec's lowercase status set; the existing CHECK only
-- allowed legacy Present/Absent/Leave. Widen it to allow BOTH (legacy rows are
-- preserved; new rows use the spec set). Additive; nothing dropped.
--   §8.3: present · absent · rotation_leave · rest_day · double_duty ·
--         relief_cover · blocked  (absent reason on absent_reason).

alter table public.attendance_records drop constraint if exists attendance_records_status_check;
alter table public.attendance_records add constraint attendance_records_status_check
  check (status in (
    -- legacy (existing rows)
    'Present','Absent','Leave',
    -- Phase 6 spec set
    'present','absent','rotation_leave','rest_day','double_duty','relief_cover','blocked'
  ));
