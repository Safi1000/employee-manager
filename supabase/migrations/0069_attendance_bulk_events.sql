-- 0067: Attendance bulk-action audit events (Phase 5b).
--
-- attendance_records is intentionally NOT in the generic audited-tables list
-- (per-day marks would flood the Audit Log). But the spec requires the bulk
-- "Mark All Present" and its "Undo" to each appear as ONE distinct audit entry.
--
-- We record each bulk action as a single row here; the generic audit trigger
-- (0041) then produces exactly one audit_log entry per action, visible in
-- ADMIN → Audit Log alongside everything else.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_bulk_action') then
    create type attendance_bulk_action as enum ('mark_all_present', 'undo_mark_all_present');
  end if;
end$$;

create table if not exists public.attendance_bulk_events (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  action           attendance_bulk_action not null,
  attendance_date  date not null,
  affected_count   integer not null default 0,
  -- The filters active on the page when the action ran (client/location/etc.).
  filters          jsonb,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_attendance_bulk_events_company on public.attendance_bulk_events(company_id);
create index if not exists idx_attendance_bulk_events_date    on public.attendance_bulk_events(attendance_date);

drop trigger if exists trg_aaa_attendance_bulk_events_fill_company on public.attendance_bulk_events;
create trigger trg_aaa_attendance_bulk_events_fill_company
  before insert on public.attendance_bulk_events
  for each row execute function public.fill_company_id();

alter table public.attendance_bulk_events enable row level security;

drop policy if exists "ssa_all" on public.attendance_bulk_events;
create policy "ssa_all" on public.attendance_bulk_events for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.attendance_bulk_events;
create policy "company_members" on public.attendance_bulk_events for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- One audit_log entry per bulk action.
drop trigger if exists trg_zzz_attendance_bulk_events_audit on public.attendance_bulk_events;
create trigger trg_zzz_attendance_bulk_events_audit
  after insert or update or delete on public.attendance_bulk_events
  for each row execute function public.log_audit_change();
