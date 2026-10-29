-- 0595 — every export is logged
--
-- Shayan, 29 Oct 2026: "yes" — item 7 of the security sweep. A PDF or Excel
-- file leaves Bastion for good once downloaded; what the database can keep is
-- who took which file, when, from which screen. The file itself carries the
-- same answer: every PDF page and every workbook is stamped "Exported by
-- <name> · <time>" by the release that ships with this (src/app/lib/saveFile.ts,
-- lib/excel.ts), so a leaked file names its source.
--
--   public.export_log   one row per download: company, user, time, file name,
--                       kind (pdf / xlsx / csv / …), screen path.
--   public.log_export() the only way in: it writes the caller's own row, never
--                       anyone else's. Called fire-and-forget by saveBlob().
--   read                users.manage or audit_log.view (Access & Governance ›
--                       a user's Security panel; the weekly digest, next).
--
-- Asserted: as the HR login, log_export() writes a row for that login and none
-- other, a direct insert is refused, and the HR login cannot read the log;
-- Shayan reads it (rolled back by a sentinel whose message is checked).

create table if not exists public.export_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  exported_at timestamptz not null default now(),
  file_name   text not null,
  kind        text,
  screen      text
);
comment on table public.export_log is
  'DECIDED 0595: one row per file downloaded from Bastion (saveBlob → log_export). Written only by log_export() for the caller; read with users.manage or audit_log.view.';
create index if not exists export_log_company_at on public.export_log (company_id, exported_at desc);
create index if not exists export_log_user_at on public.export_log (user_id, exported_at desc);
alter table public.export_log enable row level security;
revoke all on public.export_log from anon, authenticated;
grant select on public.export_log to authenticated;
drop policy if exists admin_read on public.export_log;
create policy admin_read on public.export_log for select using (
  (company_id = (select public.current_company_id()) and ((select public.has_perm('users.manage')) or (select public.has_perm('audit_log.view'))))
  or (select public.is_ssa_unscoped()));

create or replace function public.log_export(p_file_name text, p_kind text default null, p_screen text default null)
returns void
language sql
security definer
set search_path = public
as $$
  -- 0595. The caller's own export, and nobody else's.
  insert into public.export_log (company_id, user_id, file_name, kind, screen)
  select public.current_company_id(), auth.uid(), left(coalesce(nullif(btrim(p_file_name), ''), 'export'), 300),
         left(p_kind, 20), left(p_screen, 200)
   where auth.uid() is not null;
$$;
comment on function public.log_export(text, text, text) is
  'TENANT GUARD EXEMPT: no uuid argument; writes only the caller''s own row in the caller''s company (0595).';
revoke all on function public.log_export(text, text, text) from public, anon;
grant execute on function public.log_export(text, text, text) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('log_export', null, 'EXEMPT 0595: every login logs its own exports')
on conflict (function_name) do nothing;

do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_msg text; v_n bigint;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.log_export('0595 test.pdf', 'pdf', '/super-admin/test');
    v_msg := null;
    begin
      insert into public.export_log (user_id, file_name) values (v_boss, 'forged.pdf');
    exception when others then get stacked diagnostics v_msg = message_text;
    end;
    select count(*) into v_n from public.export_log;
    execute 'reset role';
    if v_msg is null or v_msg not like 'permission denied%' then raise exception '0595 REFUSED: a direct insert said "%".', v_msg; end if;
    if v_n <> 0 then raise exception '0595 REFUSED: the HR login reads % export rows.', v_n; end if;
    if (select count(*) from public.export_log where file_name = '0595 test.pdf' and user_id = v_hr) <> 1 then
      raise exception '0595 REFUSED: log_export did not write exactly one row for the caller.';
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into v_n from public.export_log where file_name = '0595 test.pdf';
    execute 'reset role';
    if v_n <> 1 then raise exception '0595 REFUSED: Shayan reads % of the test row.', v_n; end if;
    raise exception '0595-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0595-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0595 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
