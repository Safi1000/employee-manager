-- 0596 — a weekly security digest
--
-- Shayan, 29 Oct 2026: "yes" — item 8 of the security sweep. 0591–0595 record
-- logins, devices, disables, exports and backups; someone still has to look.
-- security_digest() folds a week of it into one answer, which the Edge Function
-- security-digest emails to each super-admin every Monday morning and Access &
-- Governance shows on demand.
--
-- public.security_digest(p_company_id, p_days = 7) → jsonb:
--   logins        per person: logins, new devices, logins between 00:00 and
--                 05:00 Pakistan time
--   new_devices   each first-time device: who, device, address, when
--   two_factor    logins still without an authenticator, and their deadline
--   disabled      logins disabled in the window: who, why, by whom
--   exports       per person: files downloaded; and the ten most recent
--   permissions   profile changes in the window: who, keys added, keys removed,
--                 role / region changes
--   backups       runs in the window: when, ok, size, error
--   red_checks    ledger_checks() rows not passing now
--   gaps          security_gaps() rows now
-- users.manage to call it as a person; the service role (the Monday job) calls
-- it for every company.
--
--   cron 'weekly-security-digest'  Monday 08:00 Pakistan time (03:00 UTC).
--
-- Asserted: as Shayan the digest returns every section; the HR login is refused
-- with the exact message; the job is scheduled once; no security gap.

create or replace function public.security_digest(p_company_id uuid, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0596. A week of login security, for one company, in one answer.
  declare v_from timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 31)));
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('users.manage'); end if;
    -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given
    if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

    return jsonb_build_object(
      'company', (select name from public.companies where id = p_company_id),
      'from', v_from, 'to', now(),
      'logins', coalesce((
        select jsonb_agg(x order by x->>'name') from (
          select jsonb_build_object('name', coalesce(p.full_name, p.email), 'logins', count(e.*),
                   'new_devices', count(*) filter (where e.new_device),
                   'odd_hours', count(*) filter (where extract(hour from e.logged_in_at at time zone 'Asia/Karachi') < 5)) x
            from public.login_events e join public.profiles p on p.id = e.user_id
           where e.company_id = p_company_id and e.logged_in_at >= v_from
           group by p.id, p.full_name, p.email) s), '[]'::jsonb),
      'new_devices', coalesce((
        select jsonb_agg(jsonb_build_object('name', coalesce(p.full_name, p.email), 'device', left(e.user_agent, 160),
                 'ip', e.ip, 'at', e.logged_in_at) order by e.logged_in_at desc)
          from public.login_events e join public.profiles p on p.id = e.user_id
         where e.company_id = p_company_id and e.logged_in_at >= v_from and e.new_device), '[]'::jsonb),
      'two_factor', coalesce((
        select jsonb_agg(jsonb_build_object('name', coalesce(p.full_name, p.email), 'required_from', p.mfa_required_from) order by p.full_name)
          from public.profiles p
         where p.company_id = p_company_id and p.disabled_at is null and p.mfa_required_from is not null
           and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')), '[]'::jsonb),
      'disabled', coalesce((
        select jsonb_agg(jsonb_build_object('name', coalesce(p.full_name, p.email), 'reason', p.disabled_reason, 'at', p.disabled_at,
                 'by', (select coalesce(b.full_name, b.email) from public.profiles b where b.id = p.disabled_by)) order by p.disabled_at desc)
          from public.profiles p
         where p.company_id = p_company_id and p.disabled_at >= v_from), '[]'::jsonb),
      'exports', jsonb_build_object(
        'by_person', coalesce((
          select jsonb_agg(jsonb_build_object('name', n, 'files', c) order by c desc) from (
            select coalesce(p.full_name, p.email) n, count(*) c
              from public.export_log x join public.profiles p on p.id = x.user_id
             where x.company_id = p_company_id and x.exported_at >= v_from
             group by 1) s), '[]'::jsonb),
        'recent', coalesce((
          select jsonb_agg(jsonb_build_object('name', n, 'file', f, 'at', a) order by a desc) from (
            select coalesce(p.full_name, p.email) n, x.file_name f, x.exported_at a
              from public.export_log x join public.profiles p on p.id = x.user_id
             where x.company_id = p_company_id and x.exported_at >= v_from
             order by x.exported_at desc limit 10) s), '[]'::jsonb)),
      'permissions', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'name', coalesce(t.full_name, t.email), 'at', a.changed_at,
                 'by', (select coalesce(b.full_name, b.email) from public.profiles b where b.id = a.changed_by),
                 'added', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_array_elements_text(coalesce(a.changes->'permissions'->'after', '[]')) k
                            where not (coalesce(a.changes->'permissions'->'before', '[]') ? k)),
                 'removed', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_array_elements_text(coalesce(a.changes->'permissions'->'before', '[]')) k
                            where not (coalesce(a.changes->'permissions'->'after', '[]') ? k)),
                 'role', a.changes->'role', 'region', a.changes->'branch_id') order by a.changed_at desc)
          from public.audit_log a left join public.profiles t on t.id = a.record_id
         where a.company_id = p_company_id and a.table_name = 'profiles' and a.changed_at >= v_from
           and (a.changes ? 'permissions' or a.changes ? 'role' or a.changes ? 'branch_id' or a.changes ? 'user_type')), '[]'::jsonb),
      'backups', coalesce((
        select jsonb_agg(jsonb_build_object('at', r.started_at, 'ok', r.ok, 'bytes', r.bytes, 'rows', r.rows_exported, 'error', r.error) order by r.started_at desc)
          from public.backup_runs r where r.started_at >= v_from), '[]'::jsonb),
      'red_checks', coalesce((
        select jsonb_agg(jsonb_build_object('check', c.check_name, 'actual', c.actual, 'expected', c.expected))
          from public.ledger_checks(p_company_id) c where not c.passed), '[]'::jsonb),
      'gaps', coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'object', g.object_name, 'detail', g.detail)) from public.security_gaps() g), '[]'::jsonb)
    );
  end $$;
comment on function public.security_digest(uuid, integer) is
  '0596: a week of login security for one company — logins, new devices, two-factor, disables, exports, permission changes, backups, red checks, gaps. users.manage, or the service role.';
revoke all on function public.security_digest(uuid, integer) from public, anon;
grant execute on function public.security_digest(uuid, integer) to authenticated, service_role;
insert into public.api_function_gates (function_name, any_of, reason)
values ('security_digest', '{users.manage}', 'Access & Governance › This week (0596)')
on conflict (function_name) do nothing;

create or replace function public.invoke_security_digest()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
  -- 0596. pg_cron's door to the security-digest Edge Function.
  declare v_key text; v_url text; v_id bigint;
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
    if v_key is null then raise exception 'Vault secret service_role_key is missing.'; end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url' limit 1;
    v_url := coalesce(v_url, 'https://mmkfpnshxjcyijhuydgr.supabase.co');
    select net.http_post(
      url := v_url || '/functions/v1/security-digest',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000)
      into v_id;
    return v_id;
  end $$;
comment on function public.invoke_security_digest() is 'TENANT GUARD EXEMPT: no argument; called by pg_cron (0596).';
revoke all on function public.invoke_security_digest() from public, anon, authenticated;

do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'weekly-security-digest';
  perform cron.schedule('weekly-security-digest', '0 3 * * 1', 'select public.invoke_security_digest();');
end $cron$;

do $test$
declare v_d jsonb; v_msg text; k text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);
  v_d := public.security_digest('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 7);
  foreach k in array array['logins','new_devices','two_factor','disabled','exports','permissions','backups','red_checks','gaps'] loop
    if not (v_d ? k) then raise exception '0596 REFUSED: the digest has no "%" section.', k; end if;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', 'c27a9602-6776-401a-a2c1-d755124b931b', 'role', 'authenticated')::text, true);
  v_msg := null;
  begin perform public.security_digest('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 7); exception when others then get stacked diagnostics v_msg = message_text; end;
  if v_msg is distinct from 'permission denied: users.manage required' then raise exception '0596 REFUSED: HR said "%".', v_msg; end if;
  perform set_config('request.jwt.claims', '{}', true);
  if (select count(*) from cron.job where jobname = 'weekly-security-digest') <> 1 then raise exception '0596 REFUSED: the job is not scheduled once.'; end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0596 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0596 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
