-- 0591 — a login is two-factor, watched, and revocable at once
--
-- Shayan, 29 Oct 2026: "lets strict loggin in a bit sessions limit or app
-- limits", then — of two-factor for everyone — "hmmm maybe everyone", and of
-- the build list, "sure". The inactivity logout stays at 15 minutes ("what is
-- now"). Public sign-up is left as is: signup-complete creates a company only
-- after a Stripe payment clears.
--
-- 1. TWO-FACTOR FOR EVERY LOGIN. profiles.mfa_required_from — from that moment
--    a login whose token is not aal2 (password + authenticator code) is refused
--    by the API gate on every path except what the enrolment screen needs
--    (GET /profiles, GET /companies, /rpc/my_session_status,
--    /rpc/enforce_subscription_expiry). Every existing login: 5 Nov 2026 — a
--    week to enrol. A new login: seven days from creation (the default).
--    NULL = not required (site supervisors, Phase 1, get device + PIN instead).
--
-- 2. A SESSION THAT ENDS, ENDS NOW. The gate refuses a token whose session is
--    gone from auth.sessions, or whose user is disabled. A signed-out or
--    revoked login stops at the next request instead of living out its
--    one-hour token.
--
-- 3. DISABLE, SIGN OUT EVERYWHERE, RESET TWO-FACTOR — end_user_sessions,
--    set_user_disabled, reset_user_mfa. users.manage, same company, never on
--    oneself, never on the super-super-admin. Disabling sets auth.users
--    .banned_until (no new login) and ends every session (no old one).
--    profiles.disabled_at / mfa_required_from change ONLY through these: the
--    profiles protection trigger refuses them otherwise, super-admin included.
--
-- 4. LOGIN HISTORY. public.login_events — one row per session created, with IP
--    and device (user agent), copied by a trigger on auth.sessions so it
--    outlives logout. A device a user has never logged in from before raises a
--    'security' alert to the company. Read by the user himself and by
--    users.manage. The trigger can never block a login: any error inside it is
--    swallowed. Backfilled from the 269 sessions on record (no alerts).
--
-- The gate is restated (one author, 0585) behind a digest precondition; the
-- profiles trigger is amended by surgery (one author, but small edits are
-- safer than restating access rules).
--
-- Asserted, with simulated requests and inside rolled-back blocks whose
-- sentinel message is checked: a live session passes; a missing one is refused
-- "session ended"; a disabled user is refused "account disabled"; past the
-- grace an aal1 token is refused on a report and admitted on GET /profiles,
-- an aal2 token is admitted, and within the grace an aal1 token is admitted;
-- a new session writes a login_event flagged new_device and raises one alert,
-- and a second session from the same device raises none; the admin functions
-- refuse a login without users.manage with the exact message, and as Shayan
-- end a user's sessions; a direct update of disabled_at is refused.

-- ── 1. columns ──────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists mfa_required_from timestamptz default (now() + interval '7 days');
alter table public.profiles add column if not exists disabled_at timestamptz;
alter table public.profiles add column if not exists disabled_reason text;
alter table public.profiles add column if not exists disabled_by uuid references auth.users(id);
comment on column public.profiles.mfa_required_from is
  'DECIDED 0591: from this moment the API refuses this login unless its token is aal2 (password + authenticator code). NULL = not required. '
  'Changed only by reset_user_mfa(); a new login gets seven days.';
comment on column public.profiles.disabled_at is
  'DECIDED 0591: set by set_user_disabled(); the API refuses every request and auth refuses every login (banned_until) while set.';
update public.profiles set mfa_required_from = '2026-11-05 00:00:00+05' where mfa_required_from is null or mfa_required_from > '2026-11-05 00:00:00+05';

-- ── 2. the protection trigger also guards them ──────────────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.profiles_protect_access_columns()'::regprocedure);
  a constant text := E'\n  return new;\nend;\n';
  v_n int;
begin
  if position('0591' in v_def) > 0 then return; end if;   -- replay
  v_n := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_n <> 1 then raise exception '0591 REFUSED: the closing anchor appears % times in profiles_protect_access_columns.', v_n; end if;
  execute replace(v_def, a,
       E'\n  -- 0591: two-factor and disabled state change only through reset_user_mfa /\n'
    || E'  -- set_user_disabled, which mark the transaction; a direct edit — the user''s own\n'
    || E'  -- self_update, or a super-admin''s — is refused.\n'
    || E'  if (new.mfa_required_from, new.disabled_at, new.disabled_reason, new.disabled_by)\n'
    || E'     is distinct from (old.mfa_required_from, old.disabled_at, old.disabled_reason, old.disabled_by)\n'
    || E'     and coalesce(current_setting(''bastion.access_change'', true), '''') <> ''0591'' then\n'
    || E'    raise exception ''Two-factor and disabled state change only through Access & Governance.'' using errcode = ''42501'';\n'
    || E'  end if;\n'
    || E'\n  return new;\nend;\n');
end $surgery$;

-- ── 3. login history ────────────────────────────────────────────────────────
create table if not exists public.login_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid references public.companies(id) on delete cascade,
  session_id  uuid,
  logged_in_at timestamptz not null,
  ip          text,
  user_agent  text,
  new_device  boolean not null default false
);
comment on table public.login_events is
  'DECIDED 0591: one row per session created (auth.sessions), kept after logout. Read by the user himself and by users.manage. '
  'new_device = no earlier login of this user from the same user agent.';
create index if not exists login_events_user_at on public.login_events (user_id, logged_in_at desc);
create unique index if not exists login_events_session on public.login_events (session_id) where session_id is not null;
alter table public.login_events enable row level security;
drop policy if exists own_or_admin_read on public.login_events;
create policy own_or_admin_read on public.login_events for select using (
  user_id = (select auth.uid())
  or (company_id = (select public.current_company_id()) and (select public.has_perm('users.manage')))
  or (select public.is_ssa_unscoped()));
revoke insert, update, delete on public.login_events from anon, authenticated;

insert into public.login_events (user_id, company_id, session_id, logged_in_at, ip, user_agent, new_device)
select s.user_id, p.company_id, s.id, s.created_at, host(s.ip), s.user_agent,
       row_number() over (partition by s.user_id, coalesce(s.user_agent, '') order by s.created_at) = 1
  from auth.sessions s left join public.profiles p on p.id = s.user_id
 where not exists (select 1 from public.login_events e where e.session_id = s.id);

create or replace function public.record_login_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
  -- 0591. Copies a new auth.sessions row into login_events and flags a device
  -- the user has never used. NEVER blocks a login: any failure is swallowed.
  declare v_company uuid; v_name text; v_new boolean; v_had boolean;
  begin
    begin
      select p.company_id, coalesce(p.full_name, p.email) into v_company, v_name from public.profiles p where p.id = new.user_id;
      select exists (select 1 from public.login_events e where e.user_id = new.user_id) into v_had;
      select not exists (select 1 from public.login_events e where e.user_id = new.user_id and coalesce(e.user_agent, '') = coalesce(new.user_agent, '')) into v_new;
      insert into public.login_events (user_id, company_id, session_id, logged_in_at, ip, user_agent, new_device)
      values (new.user_id, v_company, new.id, coalesce(new.created_at, now()), host(new.ip), new.user_agent, v_new)
      on conflict do nothing;
      if v_new and v_had and v_company is not null then
        perform public.raise_alert(v_company, 'warning', 'security',
          format('%s signed in from a new device: %s (%s)', coalesce(v_name, 'A user'),
                 left(coalesce(new.user_agent, 'unknown device'), 120), coalesce(host(new.ip), 'unknown address')),
          'login_events', null, null);
      end if;
    exception when others then
      null;   -- a login is never refused because its history could not be written
    end;
    return new;
  end $$;
revoke all on function public.record_login_event() from public, anon, authenticated;
drop trigger if exists bastion_record_login_event on auth.sessions;
create trigger bastion_record_login_event after insert on auth.sessions
  for each row execute function public.record_login_event();

-- ── 4. what a login may ask about itself ────────────────────────────────────
create or replace function public.my_session_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- 0591. The caller's own session and two-factor state, for the screen that
  -- decides whether to ask for a code, ask for enrolment, or sign out.
  select jsonb_build_object(
    'alive',        exists (select 1 from auth.sessions s where s.id = nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'session_id', '')::uuid),
    'disabled',     p.disabled_at is not null,
    'mfa_required_from', p.mfa_required_from,
    'mfa_enforced', p.mfa_required_from is not null and p.mfa_required_from <= now(),
    'aal',          coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', 'aal1'),
    'factors',      (select count(*) from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'))
  from public.profiles p where p.id = auth.uid();
$$;
comment on function public.my_session_status() is 'TENANT GUARD EXEMPT: takes no argument; reads only the caller''s own profile and session (0591).';
revoke all on function public.my_session_status() from public, anon;
grant execute on function public.my_session_status() to authenticated;

-- ── 5. the admin actions ────────────────────────────────────────────────────
create or replace function public.access_target_check(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0591. Shared refusal for the three actions below: users.manage, a user of
  -- the caller's company, not oneself, not the super-super-admin.
  declare t public.profiles;
  begin
    if auth.uid() is not null then perform public.require_perm('users.manage'); end if;
    select * into t from public.profiles where id = p_user_id;
    if t.id is null then raise exception 'That user does not exist.' using errcode = 'P0001'; end if;
    -- tenant guard [resolved]: owning company from p_user_id via public.profiles
    if not public.is_super_super_admin() then perform public.assert_same_company(t.company_id); end if;
    if t.id = auth.uid() then raise exception 'You cannot do this to your own login.' using errcode = 'P0001'; end if;
    if t.role::text = 'super_super_admin' then raise exception 'The super-super-admin is managed outside the company.' using errcode = 'P0001'; end if;
  end $$;
revoke all on function public.access_target_check(uuid) from public, anon, authenticated;

create or replace function public.end_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0591. Sign out everywhere: every session of the user ends; the API gate
  -- refuses their tokens from the next request.
  declare v_n integer;
  begin
    -- tenant guard [resolved]: owning company from p_user_id via public.profiles
    if p_user_id is not null then perform public.assert_same_company((select company_id from public.profiles where id = p_user_id)); end if;
    perform public.access_target_check(p_user_id);
    delete from auth.sessions where user_id = p_user_id;
    get diagnostics v_n = row_count;
    return v_n;
  end $$;
revoke all on function public.end_user_sessions(uuid) from public, anon;
grant execute on function public.end_user_sessions(uuid) to authenticated;

create or replace function public.set_user_disabled(p_user_id uuid, p_disabled boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0591. Disable: no new login (banned_until), no old session (ended), and the
  -- gate refuses whatever token is still in a browser. Enable reverses the first.
  declare v_n integer;
  begin
    -- tenant guard [resolved]: owning company from p_user_id via public.profiles
    if p_user_id is not null then perform public.assert_same_company((select company_id from public.profiles where id = p_user_id)); end if;
    perform public.access_target_check(p_user_id);
    if p_disabled and nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Give a reason for disabling this login.' using errcode = 'P0001';
    end if;
    perform set_config('bastion.access_change', '0591', true);
    update public.profiles
       set disabled_at = case when p_disabled then now() end,
           disabled_reason = case when p_disabled then btrim(p_reason) end,
           disabled_by = case when p_disabled then auth.uid() end
     where id = p_user_id;
    get diagnostics v_n = row_count;
    perform set_config('bastion.access_change', '', true);
    if v_n <> 1 then raise exception 'The login could not be updated.' using errcode = 'P0001'; end if;
    update auth.users set banned_until = case when p_disabled then 'infinity'::timestamptz end where id = p_user_id;
    if p_disabled then delete from auth.sessions where user_id = p_user_id; end if;
  end $$;
revoke all on function public.set_user_disabled(uuid, boolean, text) from public, anon;
grant execute on function public.set_user_disabled(uuid, boolean, text) to authenticated;

create or replace function public.reset_user_mfa(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0591. A lost phone: the user's authenticator is removed, their sessions
  -- end, and they must enrol a new one at their next login (required from now).
  declare v_n integer;
  begin
    -- tenant guard [resolved]: owning company from p_user_id via public.profiles
    if p_user_id is not null then perform public.assert_same_company((select company_id from public.profiles where id = p_user_id)); end if;
    perform public.access_target_check(p_user_id);
    delete from auth.mfa_factors where user_id = p_user_id;
    delete from auth.sessions where user_id = p_user_id;
    perform set_config('bastion.access_change', '0591', true);
    update public.profiles set mfa_required_from = now() where id = p_user_id;
    get diagnostics v_n = row_count;
    perform set_config('bastion.access_change', '', true);
    if v_n <> 1 then raise exception 'The login could not be updated.' using errcode = 'P0001'; end if;
  end $$;
revoke all on function public.reset_user_mfa(uuid) from public, anon;
grant execute on function public.reset_user_mfa(uuid) to authenticated;

create or replace function public.user_security_overview()
returns table (user_id uuid, two_factor boolean, mfa_required_from timestamptz, last_login timestamptz,
               last_ip text, last_device text, disabled_at timestamptz, disabled_reason text)
language sql
stable
security definer
set search_path = public
as $$
  -- 0591. Per login of the caller's company, for Access & Governance: has it a
  -- verified authenticator, when must it, its last login, and is it disabled.
  -- auth.mfa_factors is not readable from the browser; this is the window onto it.
  select p.id,
         exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
         p.mfa_required_from, le.logged_in_at, le.ip, le.user_agent, p.disabled_at, p.disabled_reason
    from public.profiles p
    left join lateral (select e.logged_in_at, e.ip, e.user_agent from public.login_events e
                        where e.user_id = p.id order by e.logged_in_at desc limit 1) le on true
   where (public.has_perm('users.manage') and p.company_id = public.current_company_id())
      or public.is_ssa_unscoped();
$$;
comment on function public.user_security_overview() is
  'TENANT GUARD EXEMPT: takes no argument; returns only the caller''s company, and only with users.manage (0591).';
revoke all on function public.user_security_overview() from public, anon;
grant execute on function public.user_security_overview() to authenticated;

insert into public.api_function_gates (function_name, any_of, reason) values
  ('user_security_overview', '{users.manage}', 'Access & Governance (0591)'),
  ('my_session_status', null, 'EXEMPT 0591: the caller''s own session and two-factor state'),
  ('end_user_sessions', '{users.manage}', 'Access & Governance (0591)'),
  ('set_user_disabled', '{users.manage}', 'Access & Governance (0591)'),
  ('reset_user_mfa',    '{users.manage}', 'Access & Governance (0591)')
on conflict (function_name) do nothing;

-- ── 6. the gate learns sessions, disabled logins and two-factor ─────────────
do $restate$
begin
  if md5(pg_get_functiondef('public.api_request_gate()'::regprocedure)) not in ('f0c2445c02a0255fe7f6140ab6d3fbbb') then
    if position('0591' in pg_get_functiondef('public.api_request_gate()'::regprocedure)) > 0 then return; end if;   -- replay
    raise exception '0591 REFUSED: api_request_gate is not the body 0585 wrote; an edit nobody recorded.';
  end if;
  execute $f$
create or replace function public.api_request_gate()
returns void
language plpgsql
stable
security definer
set search_path = public
as $g$
  -- 0585, restated by 0591. PostgREST's db_pre_request: runs once per API
  -- request, before it. With no user (anon, service_role) it passes.
  --   0591: the session must still exist, the login must not be disabled, and
  --         past mfa_required_from the token must be aal2 — except for what the
  --         enrolment screen needs.
  --   0585: /rpc/<name> with a row in api_function_gates listing keys needs one.
  declare
    v_path text; v_method text; v_fn text; v_keys text[]; v_claims jsonb; v_sid uuid;
    v_disabled timestamptz; v_mfa timestamptz;
  begin
    if auth.uid() is null then return; end if;
    v_path := coalesce(current_setting('request.path', true), '');
    v_method := upper(coalesce(current_setting('request.method', true), ''));
    begin v_claims := current_setting('request.jwt.claims', true)::jsonb; exception when others then v_claims := '{}'::jsonb; end;

    v_sid := nullif(v_claims ->> 'session_id', '')::uuid;
    if v_sid is not null and not exists (select 1 from auth.sessions s where s.id = v_sid) then
      raise exception 'session ended: sign in again' using errcode = '42501';
    end if;

    select p.disabled_at, p.mfa_required_from into v_disabled, v_mfa from public.profiles p where p.id = auth.uid();
    if v_disabled is not null then
      raise exception 'account disabled' using errcode = '42501';
    end if;
    if v_mfa is not null and v_mfa <= now() and coalesce(v_claims ->> 'aal', 'aal1') <> 'aal2'
       and not (v_path ~ '(^|/)rpc/(my_session_status|enforce_subscription_expiry)/?$'
                or (v_method in ('GET', 'HEAD') and v_path ~ '(^|/)(profiles|companies)/?$')) then
      raise exception 'two-factor required: enter your authenticator code' using errcode = '42501';
    end if;

    v_fn := lower(substring(v_path from '(?:^|/)rpc/([A-Za-z0-9_]+)/?$'));
    if v_fn is null then return; end if;
    select g.any_of into v_keys from public.api_function_gates g where g.function_name = v_fn;
    if v_keys is null then return; end if;
    if exists (select 1 from unnest(v_keys) k where public.has_perm(k)) then return; end if;
    raise exception 'permission denied: one of % required', array_to_string(v_keys, ', ') using errcode = '42501';
  end $g$;
$f$;
end $restate$;
comment on function public.api_request_gate() is
  'TENANT GUARD EXEMPT: takes no argument and reads only the request and the caller''s own profile and session. '
  '0585 + 0591: PostgREST db_pre_request — live session, not disabled, aal2 once two-factor is required, and the api_function_gates keys.';

-- ── 7. proof ────────────────────────────────────────────────────────────────
do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR: no users.manage
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  v_sid uuid; v_msg text; v_n bigint; v_alerts bigint;
begin
  -- a live session of Shayan's to test the gate with
  select id into v_sid from auth.sessions where user_id = v_boss order by created_at desc limit 1;
  if v_sid is null then raise exception '0591 REFUSED: no session of Shayan''s to test with.'; end if;

  begin
    -- live session, within the grace, aal1, on a report: admitted
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_sid, 'aal', 'aal1')::text, true);
    perform set_config('request.path', '/rpc/ledger_checks', true);
    perform set_config('request.method', 'POST', true);
    perform public.api_request_gate();

    -- a session that no longer exists: refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', gen_random_uuid(), 'aal', 'aal1')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'session ended: sign in again' then raise exception '0591 REFUSED: a dead session said "%".', v_msg; end if;

    -- past the grace: aal1 refused on a report, admitted on GET /profiles; aal2 admitted
    perform set_config('bastion.access_change', '0591', true);
    update public.profiles set mfa_required_from = now() - interval '1 minute' where id = v_boss;
    perform set_config('bastion.access_change', '', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_sid, 'aal', 'aal1')::text, true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'two-factor required: enter your authenticator code' then raise exception '0591 REFUSED: aal1 past the grace said "%".', v_msg; end if;
    perform set_config('request.path', '/profiles', true);
    perform set_config('request.method', 'GET', true);
    perform public.api_request_gate();
    perform set_config('request.path', '/rpc/ledger_checks', true);
    perform set_config('request.method', 'POST', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated', 'session_id', v_sid, 'aal', 'aal2')::text, true);
    perform public.api_request_gate();

    -- a disabled login: refused
    perform set_config('bastion.access_change', '0591', true);
    update public.profiles set disabled_at = now() where id = v_boss;
    perform set_config('bastion.access_change', '', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'account disabled' then raise exception '0591 REFUSED: a disabled login said "%".', v_msg; end if;

    raise exception '0591-SENTINEL-GATE';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0591-SENTINEL-GATE' then raise; end if;
  end;

  -- login history: a new device alerts once; the same device again does not.
  -- A real session is created on the auth server's own connection, where no
  -- request claims exist; '{}' stands for that (an aborted block above leaves
  -- the setting as '', which is not JSON and would fail the alert's auth.uid()).
  perform set_config('request.jwt.claims', '{}', true);
  begin
    select count(*) into v_alerts from public.alerts where category = 'security';
    insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip)
    values (gen_random_uuid(), v_hr, now(), now(), '0591-test-device/1.0', '10.0.0.1');
    select count(*) into v_n from public.login_events where user_id = v_hr and user_agent = '0591-test-device/1.0' and new_device;
    if v_n <> 1 then raise exception '0591 REFUSED: the new session wrote % new-device events.', v_n; end if;
    if (select count(*) from public.alerts where category = 'security') <> v_alerts + 1 then
      raise exception '0591 REFUSED: a new device did not raise exactly one alert.';
    end if;
    insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip)
    values (gen_random_uuid(), v_hr, now(), now(), '0591-test-device/1.0', '10.0.0.1');
    if (select count(*) from public.alerts where category = 'security') <> v_alerts + 1 then
      raise exception '0591 REFUSED: the same device raised another alert.';
    end if;
    raise exception '0591-SENTINEL-LOG';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0591-SENTINEL-LOG' then raise; end if;
  end;

  -- the admin actions: refused without users.manage; as Shayan they work
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.end_user_sessions(v_boss); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'permission denied: users.manage required' then raise exception '0591 REFUSED: HR ending sessions said "%".', v_msg; end if;
    v_msg := null; begin update public.profiles set disabled_at = now() where id = v_hr; exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Two-factor and disabled state change only through Access & Governance.' then
      raise exception '0591 REFUSED: a direct edit of disabled_at said "%".', v_msg;
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.end_user_sessions(v_hr);
    if exists (select 1 from auth.sessions where user_id = v_hr) then raise exception '0591 REFUSED: sessions survived end_user_sessions.'; end if;
    perform public.set_user_disabled(v_hr, true, '0591 test');
    if (select banned_until from auth.users where id = v_hr) is distinct from 'infinity'::timestamptz then raise exception '0591 REFUSED: disabling did not ban.'; end if;
    perform public.set_user_disabled(v_hr, false);
    if (select disabled_at from public.profiles where id = v_hr) is not null then raise exception '0591 REFUSED: enabling did not clear.'; end if;
    v_msg := null; begin perform public.end_user_sessions(v_boss); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'You cannot do this to your own login.' then raise exception '0591 REFUSED: acting on oneself said "%".', v_msg; end if;
    raise exception '0591-SENTINEL-ADMIN';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0591-SENTINEL-ADMIN' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.path', '', true);

  if (select count(*) from public.profiles where mfa_required_from is null) <> 0 then raise exception '0591 REFUSED: a login has no two-factor date.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0591 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0591 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
