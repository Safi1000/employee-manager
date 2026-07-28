-- 0140: Retire attendance_shift_overrides — superseded by dated deployment shifts.
--
-- Per-date shift is now read from the dated deployment segment covering a date
-- (deployments.shift_code, via lib/shiftOnDate.ts). The old ad-hoc per-date D/N
-- override table is no longer read or written by any code (its only live reader,
-- the attendance export, was repointed; its writers — the Shift Override tab and
-- old bulk modal — were removed). Verified: no function, view or FK references it.
--
-- Attendance itself (attendance_records) is untouched — this only removes the
-- obsolete override side-table. Safe/idempotent via IF EXISTS.

drop table if exists public.attendance_shift_overrides;
