-- 0568 — a daily note can be urgent, and a task can be done
--
-- DECIDED 2026-10-28 (Shayan), for the rebuilt daily report: "Needs attention"
-- is built only from what is entered — so two things have to be enterable:
--   * daily_client_reports.urgent — ticked beside a client's Details box; an
--     urgent note leads the report and is listed under Needs attention;
--   * daily_report_tasks.done_at / done_by — a task ticked done; a task from
--     the previous day still not done is listed under Needs attention.
-- Both are written from the Daily Reports screen (same commit as this
-- migration), under the tables' existing roster.edit write policies — no new
-- permission key.
--
-- A task is ticked done the day AFTER it was set, on a day the screen
-- otherwise shows as locked; ticking done is the one edit a past day allows.

alter table public.daily_client_reports
  add column if not exists urgent boolean not null default false;
comment on column public.daily_client_reports.urgent is
  '0568: ticked on the Daily Reports screen beside the Details box; leads the PDF and is listed under Needs attention.';

alter table public.daily_report_tasks
  add column if not exists done_at timestamptz,
  add column if not exists done_by uuid;
comment on column public.daily_report_tasks.done_at is
  '0568: ticked done on the Daily Reports screen (the day after, usually). Null = not done; a previous-day task still null is listed under Needs attention.';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'daily_client_reports' and column_name = 'urgent')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'daily_report_tasks' and column_name = 'done_at') then
    raise exception '0568 REFUSED: a column is missing.';
  end if;
  if exists (select 1 from public.daily_client_reports where urgent) then
    raise notice '0568: some notes are already urgent (replay).';
  end if;
end $$;
