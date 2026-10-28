-- 0571 — every open task is reported on, and every attendance gap explained
--
-- DECIDED 2026-10-28 (Shayan):
--   * "add a check on previous day task to be reported make it compulsory give
--     an error screen … before exporting". A task's status defaults to
--     pending, so a pending task nobody looked at and one somebody reported as
--     pending read the same. daily_report_tasks.status_reported_on records the
--     report day on which its status was last reported; the Daily Reports
--     screen refuses the daily-report export while any previous task listed on
--     that day has not been reported ON that day. A carried task (pending / in
--     progress since an earlier day) is therefore asked about every day until
--     it is completed. Enforced from report day 2026-10-29; earlier days had
--     no way to record it.
--   * HR (Nosherwan) gives the attendance report "plus his side … on why the
--     attendance is missing", and "if everything was marked i dont think his
--     side of explanations are required". attendance_gap_notes holds one
--     explanation per client per attendance date, written only for a client
--     whose attendance was not confirmed or has deployed guards left unmarked.
--     The attendance export is refused while such a client has none. Printed
--     in the attendance report beside the gap, and in the daily report's
--     "Matters requiring attention". Enforced from attendance date 2026-10-28.
--
-- Who writes: an explanation is attendance.edit (what HR holds, and what a
-- direct write to attendance requires); a task status stays roster.edit (the
-- table's existing policies). Read: company members, as every Daily Reports
-- table. No new permission key.
--
-- HR sees only the Attendance Report: the Daily Reports tab needs roster.view,
-- roster.edit or incidents.view, none of which he holds — screen-side, same
-- commit. DEFERRED: the daily-report tables stay readable to every company
-- member at the database (company_members policy, as since 0460); if the
-- answer is that HR must not be able to read them at all, the change is a
-- restrictive SELECT policy on daily_client_reports, daily_report_tasks and
-- daily_report_day_notes requiring one of those three keys.

alter table public.daily_report_tasks
  add column if not exists status_reported_on date;
comment on column public.daily_report_tasks.status_reported_on is
  '0571: the report day on which this task''s status was last reported. The daily-report export (from 2026-10-29) requires every listed previous task to have been reported on the report day itself.';

create table if not exists public.attendance_gap_notes (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  attendance_date date not null,
  client_id       uuid not null references public.clients(id) on delete cascade,
  note            text not null check (length(btrim(note)) > 0),
  updated_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint attendance_gap_notes_unique unique (company_id, attendance_date, client_id)
);
comment on table public.attendance_gap_notes is
  '0571: HR''s explanation for a client whose attendance on a date was not confirmed or left guards unmarked. One per client per date; required before the attendance report is exported (from 2026-10-28). Printed beside the gap in the attendance report and in the daily report''s Matters requiring attention.';

alter table public.attendance_gap_notes enable row level security;

drop policy if exists company_members on public.attendance_gap_notes;
create policy company_members on public.attendance_gap_notes
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.attendance_gap_notes;
create policy ssa_all on public.attendance_gap_notes
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

drop policy if exists perm_write_ins on public.attendance_gap_notes;
drop policy if exists perm_write_upd on public.attendance_gap_notes;
drop policy if exists perm_write_del on public.attendance_gap_notes;
create policy perm_write_ins on public.attendance_gap_notes
  as restrictive for insert to authenticated with check (public.has_perm('attendance.edit'));
create policy perm_write_upd on public.attendance_gap_notes
  as restrictive for update to authenticated
  using (public.has_perm('attendance.edit')) with check (public.has_perm('attendance.edit'));
create policy perm_write_del on public.attendance_gap_notes
  as restrictive for delete to authenticated using (public.has_perm('attendance.edit'));

drop trigger if exists trg_aaa_attendance_gap_notes_fill_company on public.attendance_gap_notes;
create trigger trg_aaa_attendance_gap_notes_fill_company
before insert on public.attendance_gap_notes
for each row execute function public.fill_company_id();

drop trigger if exists trg_attendance_gap_notes_updated_at on public.attendance_gap_notes;
create trigger trg_attendance_gap_notes_updated_at
before update on public.attendance_gap_notes
for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_attendance_gap_notes_audit on public.attendance_gap_notes;
create trigger trg_zzz_attendance_gap_notes_audit
after insert or update or delete on public.attendance_gap_notes
for each row execute function public.log_audit_change();

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0571 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
  if (select count(*) from public.permission_key_gaps()) <> 0 then
    raise exception '0571 REFUSED: a demanded permission key is not grantable.';
  end if;
end $$;
