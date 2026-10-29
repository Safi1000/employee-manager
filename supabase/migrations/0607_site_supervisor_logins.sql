-- 0607 — site supervisor logins: one phone, own sites, field functions only
--
-- Field app Phase 1. Shayan, 29 Oct 2026 (decisions recorded in the plan):
--   * supervisors sign in with their employee code + a 6-digit PIN, on ONE
--     phone; a new phone waits for a super admin's approval;
--   * the app only — no browser version, no Bastion screens, no money;
--   * of the guards at their site(s) they see name, code, shift, phone, photo
--     and licence / CNIC-expiry FLAGS — never the CNIC number, never pay;
--   * only super admins create supervisor accounts and approve phones.
--
--   profiles.user_type = 'site_supervisor'  marks the login.
--   profiles.site_scope uuid[]              the sites it covers.
--   field_devices                           phones per login: active / pending
--                                           / revoked. The app sends its id in
--                                           the x-bastion-device header.
--
-- THE LOCK is api_request_gate(), which already runs before every API request.
-- For a site_supervisor it now refuses everything — every table, every report,
-- every function — except /rpc/field_*; and refuses those too unless the
-- request comes from that login's ACTIVE phone (field_register_device itself
-- excepted, so a new phone can ask). Nothing below this line needs to know the
-- login exists: it never reaches a table policy.
--
-- Supervisor functions (field_*), each checking the caller's own sites:
--   field_register_device(device, label)  first phone → active; another →
--                                         pending (and a security alert).
--   field_me()                            name, code, sites, phone status.
--   field_site_roster(site)               guards posted there today.
-- Super admin functions (admin_field_*):
--   admin_field_accounts()                every supervisor login, sites, phones.
--   admin_field_set_sites(login, sites[]) which sites a login covers.
--   admin_field_decide_device(phone, status)  approve (others revoked) / revoke.
-- Logins themselves are created by the field-account Edge Function (an auth
-- user needs the admin API), which calls nothing here but writes the profile.
--
-- Surgery on api_request_gate (authors 0585, 0591, 0600): the supervisor block
-- goes after the "account disabled" check, anchor asserted exactly once.
--
-- Asserted with the HR login made a supervisor of Emaar DHA ISB for the test
-- (rolled back by a sentinel whose message is checked): a table read and a
-- non-field function are refused with the exact message; a field call from an
-- unregistered phone is refused; the first phone becomes active and passes;
-- a second phone is pending and refused; the roster of Emaar returns guards and
-- no CNIC column; another site's roster is refused; approving the second phone
-- revokes the first; HR (not a super admin) cannot list field accounts; no
-- security, tenant or branch gap.

alter table public.profiles add column if not exists site_scope uuid[] not null default '{}';
comment on column public.profiles.site_scope is
  '0607: for user_type = site_supervisor, the sites this login covers. Set only by admin_field_set_sites (super admins).';

create table if not exists public.field_devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  device_id   text not null check (length(device_id) between 8 and 200),
  label       text,
  status      text not null check (status in ('active', 'pending', 'revoked')),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz,
  decided_by  uuid references public.profiles(id),
  decided_at  timestamptz,
  unique (user_id, device_id)
);
comment on table public.field_devices is
  'DECIDED 0607: phones a site-supervisor login may use. One active at a time; a new phone is pending until a super admin approves it (which revokes the old one).';
alter table public.field_devices enable row level security;
revoke all on public.field_devices from anon, authenticated;
grant select on public.field_devices to authenticated;
drop policy if exists super_admin_read on public.field_devices;
create policy super_admin_read on public.field_devices for select using (
  exists (select 1 from public.profiles me join public.profiles o on o.id = field_devices.user_id
           where me.id = (select auth.uid()) and me.role = 'super_admin' and o.company_id = me.company_id)
  or (select public.is_ssa_unscoped()));

-- The phone the current request came from (the app's x-bastion-device header).
create or replace function public.field_request_device()
returns text
language sql
stable
set search_path = public
as $$
  -- 0607. Header names arrive lower-cased in request.headers.
  select nullif(btrim(coalesce((nullif(current_setting('request.headers', true), '')::json) ->> 'x-bastion-device', '')), '');
$$;
revoke all on function public.field_request_device() from public, anon, authenticated;

-- Is the caller a site supervisor? (A boolean about the caller.)
create or replace function public.is_site_supervisor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0607.
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.user_type = 'site_supervisor');
$$;
comment on function public.is_site_supervisor() is 'TENANT GUARD EXEMPT: a boolean about the caller only (0607).';
revoke all on function public.is_site_supervisor() from public, anon;
grant execute on function public.is_site_supervisor() to authenticated;

-- The gate.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.api_request_gate()'::regprocedure);
  v_old constant text := $old$    if v_disabled is not null then
      raise exception 'account disabled' using errcode = '42501';
    end if;$old$;
  v_new constant text := $new$    if v_disabled is not null then
      raise exception 'account disabled' using errcode = '42501';
    end if;
    -- 0607: a site supervisor reaches the field functions and nothing else,
    -- and only from its approved phone (registering a phone excepted).
    if public.is_site_supervisor() then
      v_fn := lower(substring(v_path from '(?:^|/)rpc/([A-Za-z0-9_]+)/?$'));
      if v_fn is null or v_fn !~ '^field_' then
        raise exception 'This login can only be used in the Bastion field app.' using errcode = '42501';
      end if;
      if v_fn <> 'field_register_device' and not exists (
           select 1 from public.field_devices d
            where d.user_id = auth.uid() and d.status = 'active' and d.device_id = public.field_request_device()) then
        raise exception 'This phone is not approved for this login. Ask your office to approve it.' using errcode = '42501';
      end if;
      return;
    end if;$new$;
  v_n int;
begin
  if position('-- 0607: a site supervisor reaches' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_n <> 1 then raise exception '0607 REFUSED: the anchor appears % times in api_request_gate, not once.', v_n; end if;
  execute replace(v_def, v_old, v_new);
end $surgery$;

-- ---------------------------------------------------------------- supervisor
create or replace function public.field_register_device(p_device_id text, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
  -- 0607. This phone: active if it is the login's first, else pending.
  declare v_status text; v_name text;
  begin
    if not public.is_site_supervisor() then raise exception 'Only field logins register phones.' using errcode = '42501'; end if;
    if length(coalesce(btrim(p_device_id), '')) < 8 then raise exception 'This phone did not identify itself.'; end if;
    select status into v_status from public.field_devices where user_id = auth.uid() and device_id = btrim(p_device_id);
    if v_status is not null then
      update public.field_devices set last_seen = now(), label = coalesce(nullif(btrim(p_label), ''), label)
       where user_id = auth.uid() and device_id = btrim(p_device_id);
      return v_status;
    end if;
    v_status := case when exists (select 1 from public.field_devices where user_id = auth.uid() and status = 'active') then 'pending' else 'active' end;
    insert into public.field_devices (user_id, device_id, label, status, last_seen)
    values (auth.uid(), btrim(p_device_id), nullif(left(btrim(p_label), 120), ''), v_status, now());
    if v_status = 'pending' then
      select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
      perform public.raise_alert(public.current_company_id(), 'warning', 'security',
        v_name || ' is trying to sign in to the field app on a new phone. Approve or refuse it in Access & Governance › Field accounts.',
        'field_devices', null, null);
    end if;
    return v_status;
  end $$;
comment on function public.field_register_device(text, text) is
  'TENANT GUARD EXEMPT: no uuid argument; registers the CALLER''s phone (0607).';

create or replace function public.field_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  -- 0607. Who the field app is signed in as, and what they cover.
  select jsonb_build_object(
    'name', coalesce(nullif(btrim(p.full_name), ''), e.full_name, p.email),
    'employee_code', e.employee_code,
    'device', (select d.status from public.field_devices d where d.user_id = p.id and d.device_id = public.field_request_device()),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'client', c.name, 'location', s.location) order by c.name, s.name)
                         from public.sites s left join public.clients c on c.id = s.client_id
                        where s.id = any (p.site_scope) and s.company_id = p.company_id), '[]'::jsonb))
    from public.profiles p left join public.employees e on e.id = p.employee_id
   where p.id = auth.uid() and p.user_type = 'site_supervisor';
$$;
comment on function public.field_me() is 'TENANT GUARD EXEMPT: no argument; the caller''s own login (0607).';

create or replace function public.field_site_roster(p_site_id uuid)
returns table (employee_id uuid, full_name text, employee_code text, shift text, phone text, has_photo boolean, flags text[])
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0607. The guards posted at one of the caller's sites. No CNIC number, no pay.
  -- A guard is at the site when their contract line names it — or, for a
  -- client whose lines name no site (Emaar, HMC, Dolmen: one site each), when
  -- they work for that client and this is its only or default site.
  declare v_client uuid; v_whole_client boolean;
  begin
    -- tenant guard [resolved]: the site's company, then the caller's own sites.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not exists (select 1 from public.profiles p where p.id = auth.uid()
                    and ((p.user_type = 'site_supervisor' and p_site_id = any (p.site_scope)) or p.role = 'super_admin')) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    select s.client_id, s.is_default or (select count(*) from public.sites x where x.client_id = s.client_id) = 1
      into v_client, v_whole_client from public.sites s where s.id = p_site_id;
    return query
    select e.id, e.full_name, e.employee_code, coalesce(e.shift, l.shift_code::text), e.phone,
           coalesce(nullif(btrim(e.photo_url), ''), '') <> '',
           array_remove(array[
             case when e.cnic_expiry < current_date then 'CNIC expired' end,
             case when e.guard_service_licence_expiry < current_date then 'Guard licence expired' end,
             case when e.weapon_licence_expiry < current_date then 'Weapon licence expired' end,
             case when e.medical_fitness_expiry < current_date then 'Medical expired' end
           ], null)
      from public.employees e left join public.contract_lines l on l.id = e.contract_line_id
     where (l.site_id = p_site_id or (l.site_id is null and v_whole_client and e.client_id = v_client))
       and e.status in ('Active', 'On Leave')
       and (e.lifecycle_state is null or e.lifecycle_state::text not in ('applicant', 'waitlisted'))
     order by coalesce(e.shift, l.shift_code::text), e.full_name;
  end $$;
comment on function public.field_site_roster(uuid) is
  '0607: guards posted at a site — name, code, shift, phone, has-photo, expiry flags. Only for a supervisor covering the site (or a super admin). Never CNIC numbers or pay.';

-- --------------------------------------------------------------- super admin
create or replace function public.admin_field_accounts()
returns table (user_id uuid, name text, employee_code text, sites jsonb, devices jsonb, disabled_at timestamptz, last_login timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0607. Every site-supervisor login of the caller's company.
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can manage field accounts.' using errcode = '42501';
    end if;
    return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email), e.employee_code,
           coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name) from public.sites s where s.id = any (p.site_scope)), '[]'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'status', d.status, 'first_seen', d.first_seen, 'last_seen', d.last_seen) order by d.first_seen desc)
                       from public.field_devices d where d.user_id = p.id and d.status <> 'revoked'), '[]'::jsonb),
           p.disabled_at,
           (select max(le.logged_in_at) from public.login_events le where le.user_id = p.id)
      from public.profiles p left join public.employees e on e.id = p.employee_id
     where p.company_id = public.current_company_id() and p.user_type = 'site_supervisor'
     order by 2;
  end $$;
comment on function public.admin_field_accounts() is 'TENANT GUARD EXEMPT: no argument; the caller''s company only, super admins only (0607).';

create or replace function public.admin_field_set_sites(p_user_id uuid, p_sites uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0607. Which sites a supervisor login covers.
  declare v_sites uuid[] := (select coalesce(array_agg(distinct x), '{}') from unnest(coalesce(p_sites, '{}')) x where x is not null);
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can manage field accounts.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the login's company; every site's company.
    perform public.assert_same_company((select company_id from public.profiles where id = p_user_id));
    if not exists (select 1 from public.profiles where id = p_user_id and user_type = 'site_supervisor') then
      raise exception 'That login is not a field account.';
    end if;
    if exists (select 1 from unnest(v_sites) x where not exists (select 1 from public.sites s where s.id = x and s.company_id = public.current_company_id())) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    update public.profiles set site_scope = v_sites where id = p_user_id;
  end $$;
comment on function public.admin_field_set_sites(uuid, uuid[]) is '0607: super admin sets the sites a supervisor login covers.';

create or replace function public.admin_field_decide_device(p_device_row_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0607. Approve a phone (any other active phone of that login is revoked) or revoke one.
  declare v_user uuid; n int;
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can manage field accounts.' using errcode = '42501';
    end if;
    if p_status not in ('active', 'revoked') then raise exception 'Choose approve or revoke.'; end if;
    -- tenant guard [resolved]: the phone's login's company.
    perform public.assert_same_company((select p.company_id from public.field_devices d join public.profiles p on p.id = d.user_id where d.id = p_device_row_id));
    select user_id into v_user from public.field_devices where id = p_device_row_id;
    if p_status = 'active' then
      update public.field_devices set status = 'revoked', decided_by = auth.uid(), decided_at = now()
       where user_id = v_user and status = 'active' and id <> p_device_row_id;
    end if;
    update public.field_devices set status = p_status, decided_by = auth.uid(), decided_at = now() where id = p_device_row_id;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Row not found' using errcode = '42501'; end if;
  end $$;
comment on function public.admin_field_decide_device(uuid, text) is '0607: super admin approves (revoking the old) or revokes a supervisor''s phone.';

do $grants$
declare f text;
begin
  foreach f in array array['field_register_device(text, text)', 'field_me()', 'field_site_roster(uuid)',
                           'admin_field_accounts()', 'admin_field_set_sites(uuid, uuid[])', 'admin_field_decide_device(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $grants$;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_register_device', null, 'EXEMPT 0607: field logins only, checked inside'),
  ('field_me', null, 'EXEMPT 0607: the caller''s own field login'),
  ('field_site_roster', null, 'EXEMPT 0607: the caller''s own sites, checked inside'),
  ('is_site_supervisor', null, 'EXEMPT 0607: a boolean about the caller'),
  ('admin_field_accounts', '{users.manage}', 'Access & Governance › Field accounts (0607); super admin checked inside'),
  ('admin_field_set_sites', '{users.manage}', 'Access & Governance › Field accounts (0607); super admin checked inside'),
  ('admin_field_decide_device', '{users.manage}', 'Access & Governance › Field accounts (0607); super admin checked inside')
on conflict (function_name) do nothing;

do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_emaar uuid := (select s.id from public.sites s join public.clients c on c.id = s.client_id
                    where s.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and c.name = 'Emaar DHA ISB' limit 1);
  v_other uuid := (select s.id from public.sites s where s.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
                    and s.id <> (select s2.id from public.sites s2 join public.clients c on c.id = s2.client_id where c.name = 'Emaar DHA ISB' limit 1) limit 1);
  v_msg text; v_st text; v_n int; v_b uuid;
begin
  if v_emaar is null or v_other is null then raise exception '0607 REFUSED: no Emaar site or no second site to test with.'; end if;
  begin
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_emaar] where id = v_hr;

    -- as the "supervisor"
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform set_config('request.method', 'GET', true);
    perform set_config('request.path', '/employees', true);
    perform set_config('request.headers', '{}', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This login can only be used in the Bastion field app.' then raise exception '0607 REFUSED: a table read said "%".', v_msg; end if;

    perform set_config('request.method', 'POST', true);
    perform set_config('request.path', '/rpc/security_digest', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This login can only be used in the Bastion field app.' then raise exception '0607 REFUSED: a non-field function said "%".', v_msg; end if;

    perform set_config('request.path', '/rpc/field_site_roster', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This phone is not approved for this login. Ask your office to approve it.' then raise exception '0607 REFUSED: an unregistered phone said "%".', v_msg; end if;

    v_st := public.field_register_device('test-phone-AAAA', 'Test A');
    if v_st <> 'active' then raise exception '0607 REFUSED: the first phone is %, not active.', v_st; end if;
    perform set_config('request.headers', '{"x-bastion-device":"test-phone-AAAA"}', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is not null then raise exception '0607 REFUSED: the active phone was refused: "%".', v_msg; end if;

    v_st := public.field_register_device('test-phone-BBBB', 'Test B');
    if v_st <> 'pending' then raise exception '0607 REFUSED: the second phone is %, not pending.', v_st; end if;
    perform set_config('request.headers', '{"x-bastion-device":"test-phone-BBBB"}', true);
    v_msg := null; begin perform public.api_request_gate(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This phone is not approved for this login. Ask your office to approve it.' then raise exception '0607 REFUSED: a pending phone said "%".', v_msg; end if;

    select count(*) into v_n from public.field_site_roster(v_emaar);
    if v_n = 0 then raise exception '0607 REFUSED: the Emaar roster is empty.'; end if;
    v_msg := null; begin perform public.field_site_roster(v_other); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0607 REFUSED: another site''s roster said "%".', v_msg; end if;

    v_msg := null; begin perform public.admin_field_accounts(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only a super admin can manage field accounts.' then raise exception '0607 REFUSED: a supervisor listing accounts said "%".', v_msg; end if;

    -- as Shayan
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    if not exists (select 1 from public.admin_field_accounts() a where a.user_id = v_hr) then raise exception '0607 REFUSED: the test login is not listed.'; end if;
    select id into v_b from public.field_devices where user_id = v_hr and device_id = 'test-phone-BBBB';
    perform public.admin_field_decide_device(v_b, 'active');
    if (select status from public.field_devices where user_id = v_hr and device_id = 'test-phone-AAAA') <> 'revoked' then
      raise exception '0607 REFUSED: approving the new phone did not revoke the old one.';
    end if;
    raise exception '0607-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0607-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.headers', '', true);
  if (select pg_get_function_result('public.field_site_roster(uuid)'::regprocedure)) ilike '%cnic_number%' then
    raise exception '0607 REFUSED: the roster returns a CNIC number.';
  end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0607 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0607 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name ~ 'field') then raise exception '0607 REFUSED: branch_guard_gaps() reports a field function.'; end if;
end $test$;
