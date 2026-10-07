-- 0508 — The 2026-10-08 security audit: close what the anon key and an
-- ordinary signed-in user could reach.
--
-- Every finding below was demonstrated on prod (mmkfpnshxjcyijhuydgr) inside a
-- rolled-back transaction before this file was written.
--
-- 1. A USER COULD REWRITE HIS OWN ACCESS. profiles.self_update pinned `role`
--    and nothing else. As an HR user: permissions := every key (has_perm went
--    false → true), branch_id := null (left his region), company_id := the
--    other tenant (accepted). view_as_company was open the same way, and
--    current_company_id() reads it first. → a BEFORE UPDATE trigger: only a
--    Super Super Admin moves a user between companies or views as another; only
--    a Super Admin of the user's company (or the SSA) changes his access
--    columns. Anyone may still edit his own name, avatar, alert email, and
--    clear his own view_as_company. Service-role writes (edge functions, where
--    auth.uid() is null) pass, as guard_super_admin_mutations already allows.
--
-- 2. SEVEN SECURITY DEFINER VIEWS, NO COMPANY FILTER, READABLE BY ANON.
--    Signed out, with only the public key: compliance_upcoming 491 rows (guard
--    names, licence/CNIC/medical expiries), due_invoice_reminders 21 (clients,
--    outstanding), regional_scorecard 5 (profit YTD per region), warning_alerts.
--    Signed in, every tenant and every region saw every row.
--      * six become security_invoker — the underlying tables' RLS (company and
--        region) then answers, as it does for every other read.
--      * regional_scorecard stays a definer read: "regions side by side" is
--        DECIDED (0387 — two of its readers exist to show other regions). It
--        is narrowed to the caller's company, which was never the decision.
--    anon loses SELECT on all seven.
--
-- 3. TWO BACKUP TABLES WITH RLS OFF: attendance_deleted_0413_backup and
--    deployment_dates_backup_0415 were readable AND writable by anon. RLS on,
--    every API role's grant revoked; they stay for the owner to read.
--
-- 4. STORAGE: cheque-attachments and dashboard-attachments policies tested
--    only bucket_id, so any signed-in user of either tenant could read,
--    overwrite or delete the other's files; dashboard-attachments was also a
--    public bucket. Policies now require the first path segment to be the
--    caller's company (the uploaders already write `<company_id>/…`), and the
--    bucket is private — the screens fetch signed URLs. Both buckets held 0
--    objects when this was written.
--
-- 5. ANON COULD CALL 139 FUNCTIONS, 92 OF THEM SECURITY DEFINER, including
--    invoke_send_task_alerts(), which posts to send-task-alerts with the
--    Vault service key. ROOT CAUSE: 0241 ran
--      alter default privileges in schema public revoke execute … from public
--    — a per-schema default can only ADD to the global default, never remove
--    it, so every function created since 0241 was born executable by PUBLIC
--    (anon included). The global form below is the one that works. Signed-in
--    users keep exactly what they had: the set is snapshotted and granted
--    explicitly before PUBLIC loses it, and the migration refuses if any
--    function changes for authenticated or service_role.
--    invoke_send_task_alerts is also taken from authenticated — only the cron
--    (postgres) calls it.
--
-- 6. search_path pinned on every public function that had none (44 by the
--    advisor, one SECURITY DEFINER: is_period_closed). public, extensions is
--    the platform default minus "$user", so no body resolves differently.
--
-- NOT HERE: leaked-password protection is an Auth setting, not SQL (dashboard
-- → Authentication → Passwords). The gdrive-* and send-task-alerts edge
-- functions are fixed in their own source, in the same change as this file.

-- ── 1. profiles: a user cannot rewrite his own access ───────────────────────
create or replace function public.profiles_protect_access_columns()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- Service role (edge functions) and the Super Super Admin are unrestricted.
  if auth.uid() is null or public.is_super_super_admin() then
    return new;
  end if;

  if new.company_id is distinct from old.company_id then
    raise exception 'Only a Super Super Admin can move a user to another company.'
      using errcode = '42501';
  end if;

  if new.view_as_company is not null and new.view_as_company is distinct from old.view_as_company then
    raise exception 'Only a Super Super Admin can view as another company.'
      using errcode = '42501';
  end if;

  if (new.permissions, new.branch_id, new.user_type, new.partner_scope, new.employee_id,
      new.department, new.is_rmd, new.must_change_password)
     is distinct from
     (old.permissions, old.branch_id, old.user_type, old.partner_scope, old.employee_id,
      old.department, old.is_rmd, old.must_change_password)
  then
    if not (public."current_role"() = 'super_admin' and old.company_id = public.current_company_id()) then
      raise exception 'Only a Super Admin can change a user''s access — permissions, region, user type, partner scope, linked employee, department or password reset.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.profiles_protect_access_columns() is
  '0508 (security audit 2026-10-08): profiles.self_update pinned only role, so a user could grant himself every permission, leave his region and move into another company. This is the column-level half that RLS cannot express. DECIDED: a user may edit his own name, title, email, avatar, display name and alert email, and clear his own view_as_company; nothing else about his own row.';

drop trigger if exists trg_aab_profiles_protect_access on public.profiles;
create trigger trg_aab_profiles_protect_access
  before update on public.profiles
  for each row execute function public.profiles_protect_access_columns();

-- ── 2. definer views ────────────────────────────────────────────────────────
alter view public.compliance_upcoming        set (security_invoker = true);
alter view public.due_invoice_reminders      set (security_invoker = true);
alter view public.warning_alerts             set (security_invoker = true);
alter view public.kit_holdings               set (security_invoker = true);
alter view public.clearance_finance_queue    set (security_invoker = true);
alter view public.regional_receivables_aging set (security_invoker = true);

-- regional_scorecard: still a definer read across regions (DECIDED, 0387),
-- now only the caller's company. Surgery on the live text so no column moves.
do $$
declare v_def text;
begin
  if position('current_company_id' in pg_get_viewdef('public.regional_scorecard'::regclass)) > 0 then
    return;   -- replay
  end if;
  v_def := rtrim(pg_get_viewdef('public.regional_scorecard'::regclass), E'; \n');
  execute 'create or replace view public.regional_scorecard as select * from (' || v_def
       || ') s where s.company_id = (select public.current_company_id())';
end $$;

comment on view public.regional_scorecard is
  '0508: SECURITY DEFINER on purpose — regions side by side is DECIDED (0387), so region RLS must not narrow it. It is limited to the caller''s company; before 0508 it was not, and anon could read it.';

revoke all on public.compliance_upcoming, public.due_invoice_reminders, public.warning_alerts,
              public.kit_holdings, public.clearance_finance_queue, public.regional_receivables_aging,
              public.regional_scorecard
  from anon;
revoke insert, update, delete, truncate on public.regional_scorecard from authenticated;

-- ── 3. backup tables ────────────────────────────────────────────────────────
alter table public.attendance_deleted_0413_backup enable row level security;
alter table public.deployment_dates_backup_0415  enable row level security;
revoke all on public.attendance_deleted_0413_backup, public.deployment_dates_backup_0415
  from anon, authenticated;

-- ── 4. storage ──────────────────────────────────────────────────────────────
update storage.buckets set public = false where id = 'dashboard-attachments';

drop policy if exists "cheque_attachments_read"   on storage.objects;
drop policy if exists "cheque_attachments_insert" on storage.objects;
drop policy if exists "cheque_attachments_update" on storage.objects;
drop policy if exists "cheque_attachments_delete" on storage.objects;
create policy "cheque_attachments_read" on storage.objects for select to authenticated
  using (bucket_id = 'cheque-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "cheque_attachments_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'cheque-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "cheque_attachments_update" on storage.objects for update to authenticated
  using (bucket_id = 'cheque-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text)
  with check (bucket_id = 'cheque-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "cheque_attachments_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'cheque-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);

drop policy if exists "dashboard_attachments_read"   on storage.objects;
drop policy if exists "dashboard_attachments_insert" on storage.objects;
drop policy if exists "dashboard_attachments_update" on storage.objects;
drop policy if exists "dashboard_attachments_delete" on storage.objects;
create policy "dashboard_attachments_read" on storage.objects for select to authenticated
  using (bucket_id = 'dashboard-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "dashboard_attachments_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'dashboard-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "dashboard_attachments_update" on storage.objects for update to authenticated
  using (bucket_id = 'dashboard-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text)
  with check (bucket_id = 'dashboard-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);
create policy "dashboard_attachments_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'dashboard-attachments' and (storage.foldername(name))[1] = (select public.current_company_id())::text);

-- ── 5. function EXECUTE ─────────────────────────────────────────────────────
create temp table _exec_before_0508 on commit drop as
  select p.oid,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_ok,
         has_function_privilege('service_role',  p.oid, 'EXECUTE') as svc_ok
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace;

do $$
declare r record;
begin
  for r in select b.oid, b.auth_ok, b.svc_ok from _exec_before_0508 b loop
    if r.auth_ok then execute format('grant execute on function %s to authenticated', r.oid::regprocedure); end if;
    if r.svc_ok  then execute format('grant execute on function %s to service_role',  r.oid::regprocedure); end if;
  end loop;
end $$;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
revoke execute on function public.invoke_send_task_alerts() from authenticated;

-- The global default — the one 0241 meant. Covers functions postgres creates
-- from here on, in any schema.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres revoke execute on functions from anon;

-- ── 6. search_path ──────────────────────────────────────────────────────────
do $$
declare r record;
begin
  for r in
    select p.oid from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind in ('f', 'p')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, extensions', r.oid::regprocedure);
  end loop;
end $$;

-- ── Verification: each asserts the failure it guards against ───────────────
do $$
declare v_n int; v_who text;
begin
  -- 5: nothing in public is callable signed out.
  select count(*), string_agg(p.proname, ', ') into v_n, v_who
    from pg_proc p where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_n <> 0 then raise exception '0508 FAILED: anon can still execute %: %', v_n, left(v_who, 400); end if;

  -- 5: signed-in users and the service role lost nothing (bar the one meant).
  select count(*), string_agg(p.proname, ', ') into v_n, v_who
    from _exec_before_0508 b join pg_proc p on p.oid = b.oid
   where (b.auth_ok and not has_function_privilege('authenticated', p.oid, 'EXECUTE') and p.proname <> 'invoke_send_task_alerts')
      or (b.svc_ok  and not has_function_privilege('service_role',  p.oid, 'EXECUTE'));
  if v_n <> 0 then raise exception '0508 FAILED: signed-in callers lost EXECUTE on %: %', v_n, left(v_who, 400); end if;

  if has_function_privilege('authenticated', 'public.invoke_send_task_alerts()'::regprocedure, 'EXECUTE') then
    raise exception '0508 FAILED: authenticated can still start a task-alert run.';
  end if;

  -- 2: no view in public reads past RLS except the one decided to.
  select count(*), string_agg(c.relname, ', ') into v_n, v_who
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
     and not coalesce('security_invoker=true' = any(c.reloptions) or 'security_invoker=on' = any(c.reloptions), false)
     and c.relname <> 'regional_scorecard';
  if v_n <> 0 then raise exception '0508 FAILED: definer view(s) remain: %', v_who; end if;
  if position('current_company_id' in pg_get_viewdef('public.regional_scorecard'::regclass)) = 0 then
    raise exception '0508 FAILED: regional_scorecard is not limited to the caller''s company.';
  end if;

  -- 2/3: anon reads nothing past RLS — no table without it, no view or
  -- materialized view that skips it. (An invoker view anon can SELECT is
  -- answered by the tables' RLS, which returns nothing signed out.)
  select count(*), string_agg(c.relname, ', ') into v_n, v_who
    from pg_class c where c.relnamespace = 'public'::regnamespace
     and has_table_privilege('anon', c.oid, 'SELECT')
     and (   (c.relkind in ('r', 'p') and not c.relrowsecurity)
          or  c.relkind = 'm'
          or (c.relkind = 'v' and not coalesce('security_invoker=true' = any(c.reloptions) or 'security_invoker=on' = any(c.reloptions), false)));
  if v_n <> 0 then raise exception '0508 FAILED: anon can still read past RLS: %', v_who; end if;

  -- 3: no public table without RLS.
  select count(*), string_agg(c.relname, ', ') into v_n, v_who
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if v_n <> 0 then raise exception '0508 FAILED: RLS off on %', v_who; end if;

  -- 4
  if exists (select 1 from storage.buckets where public) then
    raise exception '0508 FAILED: a public storage bucket remains.';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and policyname like any (array['cheque_attachments_%', 'dashboard_attachments_%'])
              and position('current_company_id' in coalesce(qual, '') || coalesce(with_check, '')) = 0) then
    raise exception '0508 FAILED: an attachment policy is not company-scoped.';
  end if;

  -- 1
  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_aab_profiles_protect_access' and tgenabled <> 'D') then
    raise exception '0508 FAILED: profiles access trigger missing.';
  end if;

  -- 6
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  if v_n <> 0 then raise exception '0508 FAILED: % definer function(s) without search_path.', v_n; end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0508 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
