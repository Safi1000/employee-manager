-- 0460 — Daily Reports gains three things a human has to supply, so all three
-- land with the screen that supplies them (the "half a feature" rule):
--
--   * `no_report` on daily_client_reports — an explicit "nothing to report for
--     this client today", which is NOT the same as an empty box. An empty box
--     means nobody wrote anything; the flag means somebody looked. The PDF sorts
--     on it: clients with a written note first, the no-report ones underneath.
--
--   * daily_report_day_notes — one row per (company, day) carrying the day's
--     "Next Day Task". It is a property of the DAY, not of a client, so it does
--     not belong on daily_client_reports; a column there would be N copies of
--     one sentence and the copies would disagree.
--
-- `details` is kept alongside `no_report` rather than being overloaded: a row
-- flagged no-report is stored with its details blanked by the screen, but the
-- column stays nullable so the flag is the claim and the text is the evidence.
--
-- Region filtering on the page needs no schema: clients.branch_id already is
-- the region, and the filter is a read.

alter table public.daily_client_reports
  add column if not exists no_report boolean not null default false;

comment on column public.daily_client_reports.no_report is
  'Explicitly marked "no report" for this client on this day. Distinct from an '
  'absent row (nobody looked) and from empty details (looked, wrote nothing).';

create table if not exists public.daily_report_day_notes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  report_date   date not null default current_date,
  next_day_task text,
  updated_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint daily_report_day_notes_unique unique (company_id, report_date)
);

comment on table public.daily_report_day_notes is
  'Day-level companion to daily_client_reports: the Next Day Task written once '
  'for a whole reporting day and printed at the head of that day''s PDF.';

alter table public.daily_report_day_notes enable row level security;

drop policy if exists company_members on public.daily_report_day_notes;
create policy company_members on public.daily_report_day_notes
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.daily_report_day_notes;
create policy ssa_all on public.daily_report_day_notes
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- Same write gate the rest of the Daily Reports surface carries (0313): writing
-- a day's report — client note or day note — is roster.edit.
drop policy if exists perm_write_ins on public.daily_report_day_notes;
drop policy if exists perm_write_upd on public.daily_report_day_notes;
drop policy if exists perm_write_del on public.daily_report_day_notes;
create policy perm_write_ins on public.daily_report_day_notes
  as restrictive for insert to authenticated with check (public.has_perm('roster.edit'));
create policy perm_write_upd on public.daily_report_day_notes
  as restrictive for update to authenticated
  using (public.has_perm('roster.edit')) with check (public.has_perm('roster.edit'));
create policy perm_write_del on public.daily_report_day_notes
  as restrictive for delete to authenticated using (public.has_perm('roster.edit'));

-- The trigger set every scoped table carries; aaa/zzz keep the firing order.
drop trigger if exists trg_aaa_daily_report_day_notes_fill_company on public.daily_report_day_notes;
create trigger trg_aaa_daily_report_day_notes_fill_company
before insert on public.daily_report_day_notes
for each row execute function public.fill_company_id();

drop trigger if exists trg_daily_report_day_notes_updated_at on public.daily_report_day_notes;
create trigger trg_daily_report_day_notes_updated_at
before update on public.daily_report_day_notes
for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_daily_report_day_notes_audit on public.daily_report_day_notes;
create trigger trg_zzz_daily_report_day_notes_audit
after insert or update or delete on public.daily_report_day_notes
for each row execute function public.log_audit_change();

-- The tenant-guard detector must be able to read every guard this file leaves
-- behind. This migration adds a scoped table, which is exactly the shape that
-- opened the four holes 0348/0352/0363 repaired, so it asserts rather than
-- assumes.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
