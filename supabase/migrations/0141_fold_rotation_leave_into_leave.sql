-- 0141: Fold Rotation leave into a single "Leave" status.
--
-- Attendance now offers only Present / Absent / Leave / Double duty. "Rotation
-- leave" (rotation_leave) is retired as a distinct status and treated as plain
-- Leave everywhere (UI already relabels it). Convert the existing rotation_leave
-- rows to the canonical 'Leave' token so past data reads as Leave too.
--
-- Payroll is unaffected: attendance_payroll counts leave via
-- lower(status) in ('leave','rotation_leave','rest_day'), and 'Leave' → 'leave'
-- is already in that set. No attendance is deleted; only the label/token changes.
-- 'Leave' is already permitted by attendance_records_status_check (0127).

-- The backfill-lock trigger blocks admin edits to past-dated rows; this is a
-- pure status relabel (not a backdated mark), so disable it just for this update.
alter table public.attendance_records disable trigger trg_attendance_backfill_lock;

update public.attendance_records
   set status = 'Leave'
 where status = 'rotation_leave';

alter table public.attendance_records enable trigger trg_attendance_backfill_lock;
