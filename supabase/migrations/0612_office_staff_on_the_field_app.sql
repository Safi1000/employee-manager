-- 0612 — office staff on the field app
--
-- Shayan, 30 Oct 2026: "if other office staff like me or someone else wants to
-- use [the app] … no financial data though". Then "go" to the plan:
--
--   * An office login signs in to the field app with its own Bastion email,
--     password and authenticator code. No office login is linked to an
--     employee record (0 of 7 on 30 Oct), so the supervisors' code + PIN
--     cannot serve; and the office login keeps its two-factor and 8-hour
--     session (0600) — field logins alone get 14 (0608).
--   * New permission field.app ("Use the field app"), granted on the ordinary
--     permissions screen. Super admins hold it as they hold every key.
--   * It sees every site of the company — or, for a login pinned to a region
--     (profiles.branch_id: Shafqat → Lahore, Nauman → ISB/RWP), that region's
--     clients' sites only. Supervisors are unchanged: their own sites.
--   * Its phones are approved exactly like a supervisor's (0611): pending until
--     a super admin approves them on Operations › Field Supervisors.
--
-- What changes:
--   field_can_see_site(site)   the one rule for "may this caller see this site
--                              in the field app"; field_site_roster asks it in
--                              place of its own supervisor-or-super-admin test.
--   field_office_user()        an office login (not a supervisor, not disabled)
--                              holding field.app.
--   field_me()                 restated (one author, 0607, behind its digest):
--                              also answers for an office login; adds kind,
--                              title, session_hours, and per site region and
--                              guards (field_site_roster counted).
--   field_register_device      surgery (0607, 0611): an office login may
--                              register a phone.
--   api_request_gate           surgery (many authors): an office login calling
--                              a field_* function FROM THE APP (it sends
--                              x-bastion-device) must be on an approved phone.
--                              Without the header it is the web, unchanged —
--                              Field Supervisors reads rosters that way.
--   admin_field_office_users() the office logins that may use the app, and
--                              their phones, for the Field Supervisors page.
--
-- No financial data, asserted rather than promised. A supervisor's login can
-- reach field_* functions only (0607's gate), and the app calls nothing else
-- for anyone. The test below lists every field_* function and fails on one it
-- does not know, and checks every column and key they return against a fixed
-- list with no pay, invoice, bank, expense or CNIC-number field in it. A new
-- field_* function has to be added to that list by hand, which is the point.
--
-- Asserted (rolled back by a sentinel whose message is checked) with the HR
-- login given field.app: its first phone is pending and the app is refused on
-- it, then let through once approved, and the web (no header) passes; field_me
-- says office, 8 hours, every site; pinned to Lahore it sees Lahore's sites only
-- and is refused another region's roster; without field.app it is refused
-- everywhere; Safi (supervisor) still sees exactly his one site.

-- -------------------------------------------------------------- the key
insert into public.permission_keys (key, grp, label) values
  ('field.app', 'Field app', 'Use the field app — every site''s guards on an approved phone (own region if pinned); no pay, no CNIC numbers')
on conflict (key) do nothing;

-- -------------------------------------------------------------- helpers
create or replace function public.field_office_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0612. The caller is an office login (not a site supervisor, not disabled) holding field.app.
  select exists (select 1 from public.profiles p
                  where p.id = auth.uid() and p.user_type is distinct from 'site_supervisor' and p.disabled_at is null)
         and public.has_perm('field.app');
$$;
comment on function public.field_office_user() is 'TENANT GUARD EXEMPT: a boolean about the caller only (0612).';
revoke all on function public.field_office_user() from public, anon, authenticated;

create or replace function public.field_can_see_site(p_site_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0612. May the caller see this site in the field app? A supervisor: one of
  -- its own sites. An office login with field.app: any site of its company, or
  -- of its region's clients when the login is pinned to a region.
  -- tenant guard [resolved]: the site must belong to the caller's company (the join below).
  select exists (
    select 1 from public.profiles p
      join public.sites s on s.id = p_site_id and s.company_id = p.company_id
      left join public.clients c on c.id = s.client_id
     where p.id = auth.uid() and p.disabled_at is null
       and ((p.user_type = 'site_supervisor' and p_site_id = any (p.site_scope))
            or (p.user_type is distinct from 'site_supervisor' and public.has_perm('field.app')
                and (p.branch_id is null or c.branch_id = p.branch_id))));
$$;
comment on function public.field_can_see_site(uuid) is
  'TENANT GUARD EXEMPT: a boolean about the caller; the site must be in the caller''s company (0612). The one field-app site rule.';
revoke all on function public.field_can_see_site(uuid) from public, anon, authenticated;

-- -------------------------------------------------------------- roster: ask the rule
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_site_roster(uuid)'::regprocedure);
  v_old constant text := $old$    if not exists (select 1 from public.profiles p where p.id = auth.uid()
                    and ((p.user_type = 'site_supervisor' and p_site_id = any (p.site_scope)) or p.role = 'super_admin')) then$old$;
  v_new constant text := $new$    -- 0612: one rule for who may see a site in the field app (supervisor: own sites;
    -- office login with field.app: its company's, or its region's). Super admins hold field.app.
    if not public.field_can_see_site(p_site_id) then$new$;
  v_n int;
begin
  if position('-- 0612: one rule for who may see a site' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0612 REFUSED: the roster anchor appears % times in field_site_roster, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

-- -------------------------------------------------------------- register: office logins too
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_register_device(text,text)'::regprocedure);
  v_old constant text := $old$    if not public.is_site_supervisor() then raise exception 'Only field logins register phones.' using errcode = '42501'; end if;$old$;
  v_new constant text := $new$    -- 0612: an office login holding field.app registers its phone the same way.
    if not (public.is_site_supervisor() or public.field_office_user()) then raise exception 'Only field logins register phones.' using errcode = '42501'; end if;$new$;
  v_n int;
begin
  if position('-- 0612: an office login holding field.app' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0612 REFUSED: the register anchor appears % times in field_register_device, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

-- -------------------------------------------------------------- gate: the app needs an approved phone
do $surgery$
declare
  v_def text := pg_get_functiondef('public.api_request_gate()'::regprocedure);
  v_old constant text := $old$    v_fn := lower(substring(v_path from '(?:^|/)rpc/([A-Za-z0-9_]+)/?$'));
    if v_fn is null then return; end if;$old$;
  v_new constant text := $new$    v_fn := lower(substring(v_path from '(?:^|/)rpc/([A-Za-z0-9_]+)/?$'));
    if v_fn is null then return; end if;
    -- 0612: an office login using the field app (it sends x-bastion-device) must be on a phone a
    -- super admin approved. No header = the web, unchanged.
    if v_fn ~ '^field_' and v_fn <> 'field_register_device' and public.field_request_device() is not null
       and not exists (select 1 from public.field_devices d
                        where d.user_id = auth.uid() and d.status = 'active' and d.device_id = public.field_request_device()) then
      raise exception 'This phone is not approved for this login. Ask your office to approve it.' using errcode = '42501';
    end if;$new$;
  v_n int;
begin
  if position('-- 0612: an office login using the field app' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0612 REFUSED: the gate anchor appears % times in api_request_gate, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

-- -------------------------------------------------------------- field_me: restated behind 0607's digest
do $pre$
declare v_def text := pg_get_functiondef('public.field_me()'::regprocedure);
begin
  if encode(sha256(convert_to(v_def, 'UTF8')), 'hex') <> 'e0790dd42ae6389407f46a97f43c94d2c6c70790691104d7bc75249b5fb93cd3'
     and position('-- 0612. Who the field app is signed in as' in v_def) = 0 then
    raise exception '0612 REFUSED: field_me is not the body 0607 left — an unrecorded edit. Amend by surgery instead.';
  end if;
end $pre$;

create or replace function public.field_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- 0612. Who the field app is signed in as, and the sites it shows: a supervisor's own; an
  -- office login's (field.app) every site field_can_see_site allows. NULL for anyone else.
  select jsonb_build_object(
    'name', coalesce(nullif(btrim(p.full_name), ''), e.full_name, p.email),
    'employee_code', e.employee_code,
    'kind', case when p.user_type = 'site_supervisor' then 'supervisor' else 'office' end,
    'title', p.title,
    'session_hours', case when p.user_type = 'site_supervisor' then 14 else 8 end,
    'device', (select d.status from public.field_devices d where d.user_id = p.id and d.device_id = public.field_request_device()),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'client', c.name, 'location', s.location,
                                                           'region', b.name, 'guards', (select count(*) from public.field_site_roster(s.id)))
                                        order by c.name, s.name)
                         from public.sites s
                         left join public.clients c on c.id = s.client_id
                         left join public.branches b on b.id = c.branch_id
                        where s.company_id = p.company_id and public.field_can_see_site(s.id)), '[]'::jsonb))
    from public.profiles p left join public.employees e on e.id = p.employee_id
   where p.id = auth.uid() and p.disabled_at is null
     and (p.user_type = 'site_supervisor' or public.field_office_user());
$$;
comment on function public.field_me() is 'TENANT GUARD EXEMPT: no argument; the caller''s own login (0607, 0612: office logins with field.app too).';

-- -------------------------------------------------------------- the page's list
create or replace function public.admin_field_office_users()
returns table (user_id uuid, name text, title text, region text, via text, devices jsonb, disabled_at timestamptz, last_login timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0612. Office logins of the caller's company that may use the field app (super admins, and
  -- anyone granted field.app), plus any office login that still has a phone registered.
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can manage field accounts.' using errcode = '42501';
    end if;
    return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), p.title, b.name,
           case when p.role = 'super_admin' then 'super admin'
                when 'field.app' = any (p.permissions) then 'permission'
                else 'no access' end,
           coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'status', d.status, 'first_seen', d.first_seen, 'last_seen', d.last_seen) order by d.first_seen desc)
                       from public.field_devices d where d.user_id = p.id and d.status <> 'revoked'), '[]'::jsonb),
           p.disabled_at,
           (select max(le.logged_in_at) from public.login_events le where le.user_id = p.id)
      from public.profiles p left join public.branches b on b.id = p.branch_id
     where p.company_id = public.current_company_id() and p.user_type is distinct from 'site_supervisor'
       and (p.role = 'super_admin' or 'field.app' = any (p.permissions)
            or exists (select 1 from public.field_devices d where d.user_id = p.id and d.status <> 'revoked'))
     order by 2;
  end $$;
comment on function public.admin_field_office_users() is 'TENANT GUARD EXEMPT: no argument; the caller''s company only, super admins only (0612).';
revoke all on function public.admin_field_office_users() from public, anon;
grant execute on function public.admin_field_office_users() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('admin_field_office_users', '{users.manage}', '0612: office field-app logins on the Field Supervisors page, super admins (checked inside)')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_safi  constant uuid := '5ecf72e7-3b6b-494c-86e3-0200ad5c2e13';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_lhr   constant uuid := 'a46fd702-8796-4858-b338-142628ce33cf';
  v_known constant text[] := array['field_can_see_site', 'field_guard_photo', 'field_me', 'field_office_user',
                                   'field_register_device', 'field_request_device', 'field_site_roster'];
  v_cols  constant text[] := array['employee_id', 'full_name', 'employee_code', 'shift', 'phone', 'has_photo', 'flags'];
  v_me_keys   constant text[] := array['name', 'employee_code', 'kind', 'title', 'session_hours', 'device', 'sites'];
  v_site_keys constant text[] := array['id', 'name', 'client', 'location', 'region', 'guards'];
  v_me jsonb; v_got text; v_msg text; v_n int; v_any uuid; v_other uuid; v_bad text;
begin
  -- No financial data: every field_* function is known, and returns only listed columns/keys.
  select string_agg(proname, ', ') into v_bad from pg_proc
   where pronamespace = 'public'::regnamespace and proname ~ '^field_' and not (proname = any (v_known));
  if v_bad is not null then raise exception '0612 REFUSED: field_* function(s) % not reviewed for money columns — check and add to the list.', v_bad; end if;
  select string_agg(p.proname || '.' || a.n, ', ') into v_bad
    from pg_proc p cross join lateral unnest(p.proargnames, p.proargmodes) as a(n, m)
   where p.pronamespace = 'public'::regnamespace and p.proname ~ '^field_' and a.m in ('t', 'o') and not (a.n = any (v_cols));
  if v_bad is not null then raise exception '0612 REFUSED: field_* returns unlisted column(s) %.', v_bad; end if;

  begin
    v_any := (select s.id from public.sites s join public.clients c on c.id = s.client_id
               where s.company_id = v_co and c.branch_id = v_lhr order by s.name limit 1);
    v_other := (select s.id from public.sites s join public.clients c on c.id = s.client_id
                 where s.company_id = v_co and c.branch_id is distinct from v_lhr order by s.name limit 1);
    update public.profiles set permissions = array_append(coalesce(permissions, '{}'), 'field.app'), branch_id = null where id = v_hr;
    delete from public.field_devices where user_id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    perform set_config('request.method', 'POST', true);

    -- an office login with field.app: office, 8 hours, every site, only listed keys
    v_me := public.field_me();
    if v_me ->> 'kind' is distinct from 'office' or (v_me ->> 'session_hours')::int <> 8 then
      raise exception '0612 REFUSED: field_me for an office login said kind %, % hours.', v_me ->> 'kind', v_me ->> 'session_hours';
    end if;
    if jsonb_array_length(v_me -> 'sites') <> (select count(*) from public.sites where company_id = v_co) then
      raise exception '0612 REFUSED: an unpinned office login sees % of % sites.', jsonb_array_length(v_me -> 'sites'), (select count(*) from public.sites where company_id = v_co);
    end if;
    select string_agg(k, ', ') into v_bad from jsonb_object_keys(v_me) k where not (k = any (v_me_keys));
    if v_bad is not null then raise exception '0612 REFUSED: field_me returns unlisted key(s) %.', v_bad; end if;
    select string_agg(distinct k, ', ') into v_bad from jsonb_array_elements(v_me -> 'sites') s, jsonb_object_keys(s) k where not (k = any (v_site_keys));
    if v_bad is not null then raise exception '0612 REFUSED: field_me sites carry unlisted key(s) %.', v_bad; end if;
    if (select sum((s ->> 'guards')::int) from jsonb_array_elements(v_me -> 'sites') s)
       <> (select sum((select count(*) from public.field_site_roster(x.id))) from public.sites x where x.company_id = v_co) then
      raise exception '0612 REFUSED: field_me guard counts disagree with field_site_roster.';
    end if;

    -- its phone: pending, refused by the app, let through once approved; the web needs none
    v_got := public.field_register_device('test-phone-0612-a', 'Office test phone');
    if v_got is distinct from 'pending' then raise exception '0612 REFUSED: an office login''s first phone came back "%".', v_got; end if;
    perform set_config('request.path', '/rpc/field_me', true);
    perform set_config('request.headers', json_build_object('x-bastion-device', 'test-phone-0612-a')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This phone is not approved for this login. Ask your office to approve it.' then
      raise exception '0612 REFUSED: the app on a pending office phone got "%".', v_msg;
    end if;
    update public.field_devices set status = 'active' where user_id = v_hr and device_id = 'test-phone-0612-a';
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0612 REFUSED: the app on an approved office phone got "%".', v_msg; end if;
    perform set_config('request.headers', '{}', true);
    update public.field_devices set status = 'pending' where user_id = v_hr;
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0612 REFUSED: the web (no phone header) was refused: "%".', v_msg; end if;
    perform count(*) from public.field_site_roster(v_other);

    -- pinned to Lahore: Lahore's sites only, another region's roster refused
    -- access columns change as a super admin (profiles_protect_access_columns), then back to the HR login
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set branch_id = v_lhr where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    v_me := public.field_me();
    select count(*) into v_n from jsonb_array_elements(v_me -> 'sites') s where s ->> 'region' is distinct from 'Lahore';
    if v_n <> 0 or jsonb_array_length(v_me -> 'sites') <> (select count(*) from public.sites s join public.clients c on c.id = s.client_id where s.company_id = v_co and c.branch_id = v_lhr) then
      raise exception '0612 REFUSED: a Lahore-pinned office login sees % sites outside Lahore (of %).', v_n, jsonb_array_length(v_me -> 'sites');
    end if;
    perform count(*) from public.field_site_roster(v_any);
    v_msg := null; begin perform count(*) from public.field_site_roster(v_other); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0612 REFUSED: a Lahore-pinned login reading another region got "%".', v_msg; end if;

    -- without field.app: refused everywhere
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array_remove(permissions, 'field.app'), branch_id = null where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    if public.field_me() is not null then raise exception '0612 REFUSED: an office login without field.app got a field_me.'; end if;
    v_msg := null; begin perform count(*) from public.field_site_roster(v_any); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0612 REFUSED: an office login without field.app read a roster: "%".', v_msg; end if;
    v_msg := null; begin perform public.field_register_device('test-phone-0612-b', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only field logins register phones.' then raise exception '0612 REFUSED: an office login without field.app registering a phone got "%".', v_msg; end if;

    -- the supervisor is unchanged
    perform set_config('request.jwt.claims', json_build_object('sub', v_safi, 'role', 'authenticated')::text, true);
    v_me := public.field_me();
    if v_me ->> 'kind' is distinct from 'supervisor' or (v_me ->> 'session_hours')::int <> 14
       or jsonb_array_length(v_me -> 'sites') <> (select cardinality(site_scope) from public.profiles where id = v_safi) then
      raise exception '0612 REFUSED: the supervisor''s field_me changed: %.', left(v_me::text, 200);
    end if;

    -- a super admin on the web (Field Supervisors) still reads any roster
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform count(*) from public.field_site_roster(v_other);
    if not exists (select 1 from public.admin_field_office_users() u where u.user_id = v_boss and u.via = 'super admin') then
      raise exception '0612 REFUSED: admin_field_office_users does not list the super admin.';
    end if;
    raise exception '0612-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0612-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.headers', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0612 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0612 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0612 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
