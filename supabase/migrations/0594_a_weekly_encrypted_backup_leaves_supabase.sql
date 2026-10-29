-- 0594 — a weekly encrypted backup leaves Supabase
--
-- Shayan, 29 Oct 2026: "continue with the list" — item 5 of the security
-- sweep. Losing the data is a bigger risk than leaking it, and every copy of
-- it today lives inside one Supabase project.
--
-- The backup itself is the Edge Function backup-export: every public table,
-- one NDJSON line per row, gzipped, then AES-256-GCM encrypted with
-- BACKUP_ENCRYPTION_KEY (an Edge Function secret only Shayan holds a copy of),
-- uploaded as one file to a private "Bastion Backups" folder in the company
-- Google Drive; the last eight weeks are kept. scripts/decrypt-backup.mjs
-- reverses it. This migration gives it what it needs from the database:
--
--   public.backup_runs          one row per run: when, tables, rows, bytes, the
--                               Drive file, or the error. Read by super-admins.
--   public.backup_tables()      the tables to export and whether each has an id
--                               to page by. service_role only.
--   public.invoke_backup_export() pg_net call to the function with the
--                               service-role key from Vault (the pattern of
--                               invoke_send_compliance_alerts).
--   cron 'weekly-backup'         Sunday 02:00 Pakistan time (Saturday 21:00 UTC).
--
-- Asserted: backup_tables() lists every public base table; no user role can
-- execute it or invoke_backup_export(); backup_runs is readable only with
-- settings.edit (super-admins hold it implicitly); the cron job exists once.

create table if not exists public.backup_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  ok            boolean,
  tables        integer,
  rows_exported bigint,
  bytes         bigint,
  drive_file_id text,
  file_name     text,
  triggered_by  uuid,
  error         text
);
comment on table public.backup_runs is
  'DECIDED 0594: one row per run of backup-export (weekly cron, or "Back up now"). Written by the service role only; read with settings.edit.';
alter table public.backup_runs enable row level security;
revoke all on public.backup_runs from anon, authenticated;
grant select on public.backup_runs to authenticated;
drop policy if exists admin_read on public.backup_runs;
create policy admin_read on public.backup_runs for select using ((select public.has_perm('settings.edit')));

create or replace function public.backup_tables()
returns table (table_name text, has_id boolean, approx_rows bigint)
language sql
stable
security definer
set search_path = public
as $$
  -- 0594. What backup-export exports: every base table in public.
  select c.relname::text,
         exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'id'),
         greatest(c.reltuples, 0)::bigint
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
   order by 1;
$$;
comment on function public.backup_tables() is 'TENANT GUARD EXEMPT: no argument; the catalogue. Service role only (0594).';
revoke all on function public.backup_tables() from public, anon, authenticated;
grant execute on function public.backup_tables() to service_role;

create or replace function public.invoke_backup_export()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
  -- 0594. pg_cron's door to backup-export, with the service-role key from Vault.
  declare v_key text; v_url text; v_id bigint;
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
    if v_key is null then raise exception 'Vault secret service_role_key is missing.'; end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url' limit 1;
    v_url := coalesce(v_url, 'https://mmkfpnshxjcyijhuydgr.supabase.co');
    select net.http_post(
      url := v_url || '/functions/v1/backup-export',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 300000)
      into v_id;
    return v_id;
  end $$;
comment on function public.invoke_backup_export() is 'TENANT GUARD EXEMPT: no argument; called by pg_cron (0594).';
revoke all on function public.invoke_backup_export() from public, anon, authenticated;

do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'weekly-backup';
  perform cron.schedule('weekly-backup', '0 21 * * 6', 'select public.invoke_backup_export();');
end $cron$;

do $test$
declare v_n bigint;
begin
  select count(*) into v_n from public.backup_tables();
  if v_n <> (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r') then
    raise exception '0594 REFUSED: backup_tables() lists % tables.', v_n;
  end if;
  if has_function_privilege('authenticated', 'public.backup_tables()', 'execute')
     or has_function_privilege('authenticated', 'public.invoke_backup_export()', 'execute')
     or has_function_privilege('anon', 'public.invoke_backup_export()', 'execute') then
    raise exception '0594 REFUSED: a user role can run the backup functions.';
  end if;
  if (select count(*) from cron.job where jobname = 'weekly-backup') <> 1 then raise exception '0594 REFUSED: the cron job is not there exactly once.'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c27a9602-6776-401a-a2c1-d755124b931b', 'role', 'authenticated')::text, true);
  if public.has_perm('settings.edit') then raise exception '0594 REFUSED: the HR test login holds settings.edit.'; end if;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0594 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
