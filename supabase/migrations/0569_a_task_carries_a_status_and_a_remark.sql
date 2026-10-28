-- 0569 — a task carries a status and a remark
--
-- DECIDED 2026-10-28 (Shayan): "where are the previous days tasks in this
-- report? there should be a section for that even if they are completed it
-- should say completed pending work in progress etc".
--
-- 0568 gave a task a done tick, which can say done or not — not "in progress".
-- A task now carries a status — pending, in_progress, completed — and an
-- optional short remark, set on the Daily Reports screen the day after the
-- task was set. The daily report prints every one of the previous day's tasks
-- with its status and remark, completed ones included.
--
-- done_at / done_by (0568) are kept and follow the status: set when a task is
-- marked completed, cleared otherwise — so anything already reading done_at
-- still reads the truth. Existing tasks with done_at set become completed.
-- Same roster.edit write policies; no new permission key.

alter table public.daily_report_tasks
  add column if not exists status text not null default 'pending',
  add column if not exists status_note text;
alter table public.daily_report_tasks drop constraint if exists daily_report_tasks_status_check;
alter table public.daily_report_tasks add constraint daily_report_tasks_status_check
  check (status in ('pending', 'in_progress', 'completed'));
comment on column public.daily_report_tasks.status is
  '0569: pending / in_progress / completed — set on the Daily Reports screen the day after; printed under "Previous day''s tasks". done_at follows it.';
comment on column public.daily_report_tasks.status_note is
  '0569: optional short remark on the task''s progress, printed beside its status.';

update public.daily_report_tasks set status = 'completed' where done_at is not null and status <> 'completed';

do $$
begin
  if exists (select 1 from public.daily_report_tasks where (status = 'completed') <> (done_at is not null)) then
    raise exception '0569 REFUSED: a task''s status and done_at disagree.';
  end if;
end $$;
