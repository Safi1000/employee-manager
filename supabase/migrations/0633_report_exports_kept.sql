-- 0633 — every exported report is kept, and the CEO dashboard shows the last one sent.
--
-- DECIDED by Shayan, 2 Nov 2026: the CEO dashboard shows the reports
-- themselves — Daily Operations, Attendance, Finance, Payment Follow-up — as
-- the LAST ONE SENT, exactly as it went out, with the date and who sent it, and
-- the earlier ones listed beneath. Not a chart overview: that repeated the
-- Dashboard. Not a live rebuild: the CEO sees what the team actually sent.
--
-- So each export, at the moment it is downloaded, also uploads the same PDF to
-- the private bucket report-exports under <company_id>/… and records it here
-- through record_report_export(). The copy kept is the copy downloaded — the
-- export stamp included. Kept files are never updated or deleted from the app.

insert into storage.buckets (id, name, public)
values ('report-exports', 'report-exports', false)
on conflict (id) do nothing;

-- Anyone in the company may upload into the company's folder (each report's own
-- export gate is enforced when the export is RECORDED, below). Reading is for
-- the CEO dashboard, or the person who exported that file.
drop policy if exists "report_exports_insert" on storage.objects;
create policy "report_exports_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'report-exports' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
drop policy if exists "report_exports_read" on storage.objects;
create policy "report_exports_read" on storage.objects for select to authenticated
  using (bucket_id = 'report-exports' and (storage.foldername(name))[1] = (select public.current_company_id())::text
         and ((select public.has_perm('dashboard.ceo')) or owner = (select auth.uid())));

create table public.report_exports (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  report_kind  text not null check (report_kind in ('daily', 'attendance', 'daily_attendance', 'finance', 'followup')),
  report_date  date not null,
  region_label text,
  file_path    text not null unique,
  file_name    text not null,
  exported_by  uuid default auth.uid(),
  exported_at  timestamptz not null default now()
);
create index report_exports_kind_idx on public.report_exports (company_id, report_kind, exported_at desc);
comment on table public.report_exports is
  'DECIDED 2 Nov 2026 (0633): one row per exported report PDF, kept in storage bucket report-exports, so the CEO dashboard can show the last one sent. No money. Written only by record_report_export(); read by the CEO dashboard.';
alter table public.report_exports enable row level security;
create policy company_members on public.report_exports for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.report_exports for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.report_exports as restrictive for select
  using ((select public.has_perm('dashboard.ceo')) or exported_by = (select auth.uid()));
create policy perm_write_ins on public.report_exports as restrictive for insert with check (false);
create policy perm_write_upd on public.report_exports as restrictive for update using (false) with check (false);
create policy perm_write_del on public.report_exports as restrictive for delete using (false);
grant select on public.report_exports to authenticated;

-- Record an export. The gate is the report's own export permission, so a
-- login can only file the kinds of report it can make.
create or replace function public.record_report_export(p_kind text, p_report_date date, p_region_label text, p_file_path text, p_file_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_co uuid := public.current_company_id();
begin
  if p_kind in ('daily', 'daily_attendance') and not (public.has_perm('roster.view') or public.has_perm('roster.edit') or public.has_perm('incidents.view') or public.has_perm('attendance.view')) then
    raise exception 'Your login cannot export the daily report.' using errcode = '42501';
  elsif p_kind = 'attendance' and not public.can_read_hr_report() then
    raise exception 'Your login cannot export the attendance report.' using errcode = '42501';
  elsif p_kind = 'finance' and not public.can_read_finance_report() then
    raise exception 'Your login cannot export the finance report.' using errcode = '42501';
  elsif p_kind = 'followup' and not (public.has_perm('receivables.follow_up') or public.can_see_receivable_amounts()) then
    raise exception 'Your login cannot export the payment follow-up.' using errcode = '42501';
  elsif p_kind is null or p_kind not in ('daily', 'attendance', 'daily_attendance', 'finance', 'followup') then
    raise exception 'That is not a report this records. Nothing has been recorded.';
  end if;
  if p_report_date is null or nullif(btrim(p_file_name), '') is null then
    raise exception 'The report date and file name are needed. Nothing has been recorded.';
  end if;
  if split_part(coalesce(p_file_path, ''), '/', 1) <> v_co::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'report-exports' and o.name = p_file_path) then
    raise exception 'The report file is not in this company''s folder. Nothing has been recorded.';
  end if;
  insert into public.report_exports (company_id, report_kind, report_date, region_label, file_path, file_name)
  values (v_co, p_kind, p_report_date, nullif(btrim(p_region_label), ''), p_file_path, btrim(p_file_name));
end $$;
comment on function public.record_report_export(text, date, text, text, text) is
  '0633: file an exported report PDF already uploaded to report-exports/<company_id>/…. Gate: that report''s own export permission.';

-- The CEO dashboard's list: newest first, with who sent it (profiles RLS hides
-- other users' names from a non-super-admin, hence definer).
create or replace function public.report_exports_list(p_kinds text[], p_limit int default 20)
returns table (id uuid, report_kind text, report_date date, region_label text, file_path text, file_name text, exported_at timestamptz, exported_by_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_perm('dashboard.ceo') then
    raise exception 'Your login needs "View the CEO dashboard" for this.' using errcode = '42501';
  end if;
  return query
    select r.id, r.report_kind, r.report_date, r.region_label, r.file_path, r.file_name, r.exported_at, p.full_name::text
      from public.report_exports r left join public.profiles p on p.id = r.exported_by
     where r.company_id = public.current_company_id() and r.report_kind = any (p_kinds)
     order by r.exported_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;
comment on function public.report_exports_list(text[], int) is
  '0633: the kept exports of the given kinds, newest first, with the sender''s name. Gate dashboard.ceo.';

revoke all on function public.record_report_export(text, date, text, text, text) from public, anon;
revoke all on function public.report_exports_list(text[], int) from public, anon;
grant execute on function public.record_report_export(text, date, text, text, text) to authenticated;
grant execute on function public.report_exports_list(text[], int) to authenticated;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_co uuid; v_path text; v_msg text; v_ran int := 0; v_n int;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_co := public.current_company_id();
    v_path := v_co::text || '/finance/2026-11-02/test.pdf';

    -- 1. A file that was never uploaded is refused, by message.
    v_msg := null;
    begin perform public.record_report_export('finance', current_date, null, v_path, 'Finance report.pdf'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The report file is not in this company''s folder. Nothing has been recorded.' then raise exception '0633 REFUSED: an unuploaded file got "%".', v_msg; end if;
    v_ran := v_ran + 1;

    -- 2. Once the object exists it records, and the CEO list returns it first with the sender's name.
    insert into storage.objects (bucket_id, name, owner) values ('report-exports', v_path, v_boss);
    perform public.record_report_export('finance', current_date, null, v_path, 'Finance report.pdf');
    select count(*) into v_n from public.report_exports_list(array['finance'], 1) l where l.file_path = v_path and l.exported_by_name is not null;
    if v_n <> 1 then raise exception '0633 REFUSED: the CEO list does not lead with the new export.'; end if;
    v_ran := v_ran + 1;

    -- 3. A follow-up-only login cannot file a finance report or read the list, each by message.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.record_report_export('finance', current_date, null, v_path, 'x.pdf'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login cannot export the finance report.' then raise exception '0633 REFUSED: ops filing finance got "%".', v_msg; end if;
    v_msg := null; begin perform * from public.report_exports_list(array['finance']); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs "View the CEO dashboard" for this.' then raise exception '0633 REFUSED: ops reading the list got "%".', v_msg; end if;
    v_ran := v_ran + 1;

    if v_ran <> 3 then raise exception '0633 REFUSED: % of 3 assertions ran.', v_ran; end if;
    raise exception '0633-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0633-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0633 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0633 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
