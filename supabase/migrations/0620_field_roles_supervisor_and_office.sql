-- 0620 — who does what on the field app: the site supervisor and the office
--
-- DECIDED by Shayan, 30 Oct 2026: "a site supervisor is also just a guard with
-- more responsibility and salary, whereas office staff are generally permanent
-- and long term." So:
--
--   SITE SUPERVISOR (code + PIN)  his guard list, confirming attendance and
--       reliever arrivals, and a photo for a guard who has none. Nothing else —
--       and he does not SEE what the office records at his site (visits,
--       incidents, tasks, his guards' warnings, the daily report).
--   OFFICE STAFF (field.app)      field.app alone = viewing: sites, guards,
--       attendance read-only, guard photos. Each action is its OWN key, ticked
--       per person on the permissions screen (Shayan chose split keys):
--         field.visit         site visits with the checklist
--         field.incidents     incidents and the SOS button
--         field.daily_report  a site's daily report (any office person; sending
--                             again the same day replaces it, with their name)
--         field.tasks         marking site tasks done / couldn't
--         field.warnings      raising soft / formal warnings
--       Super admins hold every key (has_perm).
--
-- On 30 Oct the only field logins were Shayan (super admin) and the test
-- supervisor Safi, so nobody loses access they were using.
--
-- The rule lives in the DATABASE, not only in the app: an old APK, or a
-- supervisor's key used by hand, is refused by the function.
--
--   field_require(key)      internal: refuses a supervisor ("done by the office"),
--                           anyone without field.app, and an office login
--                           without the key (naming its label).
--   field_office_can(key)   internal boolean, the same test without raising.
--   field_abilities()       internal: what this login may do, for field_me.
--   field_me                surgery (0607/0612 — two authors): adds 'can'.
--   the eleven field_* functions of 0615–0619 that act or read office records:
--                           surgery, a field_require line before the tenant
--                           guard; field_submit_daily_report's supervisor-only
--                           check is REPLACED by field.daily_report, and
--                           field_site_daily's can_send follows the key.
--
-- Asserted under a sentinel: a supervisor is refused by message on every one of
-- the eleven and its 'can' is roster / attendance / guard_photo; an office login
-- with field.app alone is refused naming the key and its 'can' is view-only;
-- given field.visit, it can visit; a super admin sends a site's daily report.

-- -------------------------------------------------------------- the keys
insert into public.permission_keys (key, grp, label) values
  ('field.visit',        'Field app', 'Field: site visits with the checklist'),
  ('field.incidents',    'Field app', 'Field: report incidents and SOS'),
  ('field.daily_report', 'Field app', 'Field: send a site''s daily report'),
  ('field.tasks',        'Field app', 'Field: mark site tasks done'),
  ('field.warnings',     'Field app', 'Field: raise soft or formal warnings')
on conflict (key) do nothing;

-- -------------------------------------------------------------- helpers
create or replace function public.field_require(p_key text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0620. Office staff only, and (when given) only with that key.
  declare v_label text;
  begin
    if public.is_site_supervisor() then
      raise exception 'This is done by the office, not in the site supervisor''s app.' using errcode = '42501';
    end if;
    if not public.field_office_user() then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_key is not null and not public.has_perm(p_key) then
      select label into v_label from public.permission_keys where key = p_key;
      raise exception 'Your login needs the "%" permission for this. Ask a super admin.', coalesce(v_label, p_key) using errcode = '42501';
    end if;
  end $$;
comment on function public.field_require(text) is
  '0620: internal — refuses a site supervisor, a login without field.app, and an office login without the given field.* key. DECIDED 30 Oct 2026: visits, incidents/SOS, daily report, tasks and warnings are the office''s, each by its own key.';
revoke all on function public.field_require(text) from public, anon, authenticated;

create or replace function public.field_office_can(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0620. An office field login holding this key (super admins hold every key).
  select not public.is_site_supervisor() and public.field_office_user() and public.has_perm(p_key);
$$;
comment on function public.field_office_can(text) is '0620: internal — an office field login holding the given field.* key.';
revoke all on function public.field_office_can(text) from public, anon, authenticated;

create or replace function public.field_abilities()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- 0620. What this login may do in the field app; the app shows only these.
  select case
    when public.is_site_supervisor() then '["roster", "attendance", "guard_photo"]'::jsonb
    when public.field_office_user() then '["roster", "attendance_view", "guard_photo"]'::jsonb
      || coalesce((select jsonb_agg(a.ability order by a.ord) from (values
           (1, 'visit', 'field.visit'), (2, 'incidents', 'field.incidents'), (3, 'daily_report', 'field.daily_report'),
           (4, 'tasks', 'field.tasks'), (5, 'warnings', 'field.warnings')) as a(ord, ability, perm)
          where public.has_perm(a.perm)), '[]'::jsonb)
    else '[]'::jsonb end;
$$;
comment on function public.field_abilities() is '0620: internal — the field app abilities of the caller (supervisor: roster, attendance, guard_photo; office: view plus one per field.* key held).';
revoke all on function public.field_abilities() from public, anon, authenticated;

-- -------------------------------------------------------------- field_me gains 'can' (surgery: 0607/0612)
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_me()'::regprocedure);
  a_old constant text := $a$    'session_hours', case when p.user_type = 'site_supervisor' then 14 else 8 end,$a$;
  a_new constant text := $a$    'session_hours', case when p.user_type = 'site_supervisor' then 14 else 8 end,
    'can', public.field_abilities(),  -- 0620: what this login may do$a$;
  v_n int;
begin
  if position('-- 0620: what this login may do' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0620 REFUSED: field_me anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;

-- -------------------------------------------------------------- office-only, by key (surgery on 0615–0619)
do $surgery$
declare
  anchor constant text := '    -- tenant guard [resolved]:';
  r record; v_def text; v_n int;
begin
  for r in select * from (values
      ('public.field_record_visit(uuid, jsonb, jsonb, text, text, text[], jsonb)', 'field.visit'),
      ('public.field_site_visits(uuid)',                                       'field.visit'),
      ('public.field_report_incident(uuid, text, text, text, uuid[], text[], jsonb)', 'field.incidents'),
      ('public.field_sos(uuid, text, jsonb)',                                  'field.incidents'),
      ('public.field_site_incidents(uuid)',                                    'field.incidents'),
      ('public.field_raise_warning(uuid, uuid, text, text)',                   'field.warnings'),
      ('public.field_guard_warnings(uuid, uuid)',                              'field.warnings'),
      ('public.field_site_tasks(uuid)',                                        'field.tasks'),
      ('public.field_task_update(uuid, boolean, text, text[], jsonb)',         'field.tasks'),
      ('public.field_site_daily(uuid)',                                        'field.daily_report')
    ) as t(fn, perm) loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    continue when position('-- 0620: office staff only' in v_def) > 0;
    v_n := (length(v_def) - length(replace(v_def, anchor, ''))) / length(anchor);
    if v_n <> 1 then raise exception '0620 REFUSED: % has the tenant-guard anchor % times, not once.', r.fn, v_n; end if;
    v_def := replace(v_def, anchor,
      '    -- 0620: office staff only, by key (DECIDED 30 Oct 2026).' || chr(10)
      || '    perform public.field_require(' || quote_literal(r.perm) || ');' || chr(10) || anchor);
    execute v_def;
  end loop;
end $surgery$;

-- field_site_daily: can_send follows the key, not "is a supervisor".
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_site_daily(uuid)'::regprocedure);
  a_old constant text := $a$'can_send', public.is_site_supervisor(),$a$;
  a_new constant text := $a$'can_send', public.field_office_can('field.daily_report'),$a$;
  v_n int;
begin
  if position(a_new in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0620 REFUSED: field_site_daily can_send anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;

-- field_submit_daily_report: the office sends it now, not the supervisor.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_submit_daily_report(uuid, boolean, text, boolean, text[], jsonb)'::regprocedure);
  a_old constant text := $a$    if not public.is_site_supervisor() then
      raise exception 'Only the site supervisor sends the daily site report.' using errcode = '42501';
    end if;$a$;
  a_new constant text := $a$    -- 0620: office staff only, by key (DECIDED 30 Oct 2026) — no longer the supervisor's.
    perform public.field_require('field.daily_report');$a$;
  v_n int;
begin
  if position('-- 0620: office staff only' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0620 REFUSED: field_submit_daily_report anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;
comment on function public.field_submit_daily_report(uuid, boolean, text, boolean, text[], jsonb) is
  '0619/0620: a site''s daily report (today, Pakistan), sent by office staff holding field.daily_report — any of them; sending again the same day replaces it, with the sender''s name. Not OK needs a note; urgent alerts.';
comment on table public.site_daily_reports is
  '0619/0620: the office''s end-of-day word on a site (DECIDED 30 Oct 2026: office staff with field.daily_report, not the site supervisor) — all OK or what was not, optionally urgent. One per site per day (Pakistan); sending again replaces it. Shown beside the client on Daily Reports; never written into daily_client_reports.';

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_office_msg constant text := 'This is done by the office, not in the site supervisor''s app.';
  v_known constant text[] := array['field_abilities', 'field_can_see_site', 'field_confirm_shift', 'field_geo', 'field_guard_photo', 'field_guard_warnings',
                                   'field_me', 'field_office_can', 'field_office_user', 'field_raise_warning', 'field_record_visit', 'field_register_device',
                                   'field_report_incident', 'field_request_device', 'field_require', 'field_review_escalate', 'field_set_guard_photo',
                                   'field_shift_sheet', 'field_site_daily', 'field_site_incidents', 'field_site_roster', 'field_site_tasks',
                                   'field_site_visits', 'field_sos', 'field_store_photos', 'field_submit_daily_report', 'field_task_update',
                                   'field_today'];
  v_guard uuid; v_task uuid; v_msg text; v_bad text; v_can jsonb; v_shift text;
begin
  select string_agg(proname, ', ') into v_bad from pg_proc
   where pronamespace = 'public'::regnamespace and proname ~ '^field_' and not (proname = any (v_known));
  if v_bad is not null then raise exception '0620 REFUSED: field_* function(s) % not reviewed for money columns — check and add to the list.', v_bad; end if;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id, r.shift into v_guard, v_shift from public.field_site_roster(v_site) r order by r.full_name limit 1;
    v_task := public.admin_site_task_add(v_site, 'Test task', null, null);

    -- the supervisor: refused on every office action and read, by message
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_can := public.field_me() -> 'can';
    if v_can is distinct from '["roster", "attendance", "guard_photo"]'::jsonb then raise exception '0620 REFUSED: a supervisor''s can is %.', v_can; end if;
    -- attendance stays his: the sheet opens and does not refuse him for being a supervisor
    if public.field_shift_sheet(v_site, v_shift) ->> 'why_not' = v_office_msg then
      raise exception '0620 REFUSED: the supervisor can no longer confirm attendance.';
    end if;
    for v_bad in select unnest(array[
        'select public.field_record_visit(%1$L, %2$L::jsonb, ''{}''::jsonb, null, null, ''{}''::text[], null)',
        'select public.field_site_visits(%1$L)',
        'select public.field_report_incident(%1$L, ''theft'', ''low'', ''x'', ''{}''::uuid[], ''{}''::text[], null)',
        'select public.field_sos(%1$L, null, null)',
        'select public.field_site_incidents(%1$L)',
        'select public.field_raise_warning(%1$L, %3$L, ''soft'', ''x'')',
        'select public.field_guard_warnings(%1$L, %3$L)',
        'select public.field_site_tasks(%1$L)',
        'select public.field_task_update(%4$L, true, null, ''{}''::text[], null)',
        'select public.field_site_daily(%1$L)',
        'select public.field_submit_daily_report(%1$L, true, null, false, ''{}''::text[], null)']) loop
      v_msg := null;
      begin execute format(v_bad, v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', '{}'::jsonb))::text, v_guard, v_task);
      exception when others then get stacked diagnostics v_msg = message_text; end;
      if v_msg is distinct from v_office_msg then raise exception '0620 REFUSED: a supervisor calling [%] got "%".', v_bad, v_msg; end if;
    end loop;

    -- an office login with field.app alone: view only, refused naming the key
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'office_staff', site_scope = '{}', permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_can := public.field_me() -> 'can';
    if v_can is distinct from '["roster", "attendance_view", "guard_photo"]'::jsonb then raise exception '0620 REFUSED: a field.app-only office login''s can is %.', v_can; end if;
    v_msg := null; begin perform public.field_site_visits(v_site); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: site visits with the checklist" permission for this. Ask a super admin.' then
      raise exception '0620 REFUSED: an office login without field.visit got "%".', v_msg;
    end if;
    v_msg := null; begin perform public.field_submit_daily_report(v_site, true, null, false, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: send a site''s daily report" permission for this. Ask a super admin.' then
      raise exception '0620 REFUSED: an office login without field.daily_report got "%".', v_msg;
    end if;

    -- given field.visit: it can
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['field.app', 'field.visit'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    if not public.field_office_can('field.visit') or public.field_office_can('field.warnings')
       or not (public.field_me() -> 'can') @> '["visit"]'::jsonb or (public.field_me() -> 'can') @> '["warnings"]'::jsonb then
      raise exception '0620 REFUSED: field.visit did not open visits alone: %.', public.field_me() -> 'can';
    end if;

    -- a super admin sends a site's daily report, and its can lists every key
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    if public.field_me() -> 'can' is distinct from '["roster", "attendance_view", "guard_photo", "visit", "incidents", "daily_report", "tasks", "warnings"]'::jsonb then
      raise exception '0620 REFUSED: a super admin''s can is %.', public.field_me() -> 'can';
    end if;
    delete from public.site_daily_reports where site_id = v_site and report_date = public.field_today();
    perform public.field_submit_daily_report(v_site, true, null, false, '{}', null);
    if not exists (select 1 from public.site_daily_reports where site_id = v_site and report_date = public.field_today() and sent_by = v_boss)
       or not (public.field_site_daily(v_site) ->> 'can_send')::boolean then
      raise exception '0620 REFUSED: a super admin could not send the daily report.';
    end if;
    raise exception '0620-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0620-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0620 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0620 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0620 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
