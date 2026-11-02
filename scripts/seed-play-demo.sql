-- seed-play-demo.sql — the Google Play demo company (2 Nov 2026)
--
-- APPROVED by Shayan, named, this change only: run this on crm-design
-- (mmkfpnshxjcyijhuydgr) to create the Play Store demo company with dummy
-- sites, guards, one field login and one demo super-admin login.
--
-- Why: the Play listing needs screenshots and the Play reviewer needs a login,
-- and GGS's data is private. Everything here belongs to one new company,
-- "Northgate Security (Demo)", so every field_* function's tenant guard keeps
-- it apart from GGS. Every person, client, site and phone number is invented.
--
-- What it creates
--   company   Northgate Security (Demo), prefix NGS (triggers add its Head
--             Office, chart of accounts, treasury and expense categories)
--   region    Lahore
--   clients   Aurora Business Park (2 sites), Riverside Medical Centre (1 site)
--   staff     NGS-001 supervisor (office_staff, no deployment) and ten guards
--             NGS-101..110, each deployed from 1 Oct 2026, day and night shifts
--   logins    NGS-001 field login (code + PIN), sites = all three
--             demo-admin@techxserve.com super admin (web), to approve phones
--
-- Secrets are NOT in this file: __ADMIN_PASSWORD__ and __FIELD_PIN__ are
-- substituted at run time. The field password is derived exactly as
-- supabase/functions/field-account derives it: Bastion-field:<CODE>:<PIN>.
--
-- No attendance, visits or incidents are invented. Those are made by using the
-- app on this data, which is what the screenshots should show.
--
-- One transaction: any failure leaves nothing behind. Not idempotent by
-- design — it refuses if the company already exists.

do $$
declare
  v_co uuid; v_region uuid; v_aurora uuid; v_river uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid;
  v_sup uuid; v_admin uuid := gen_random_uuid(); v_field uuid := gen_random_uuid();
  v_g uuid; r record;
  v_admin_email text := 'demo-admin@techxserve.com';
  v_field_email text := 'ngs-001@field.techxserve.com';
  v_n int;
begin
  if exists (select 1 from public.companies where name = 'Northgate Security (Demo)') then
    raise exception 'The demo company already exists. Nothing done.';
  end if;
  if exists (select 1 from auth.users where email in (v_admin_email, v_field_email)) then
    raise exception 'A demo login already exists. Nothing done.';
  end if;

  insert into public.companies (name, legal_name, contact_email, subscription_expires_at, invoice_settings)
  values ('Northgate Security (Demo)', 'Northgate Security (Demo) — sample data for the Play Store',
          v_admin_email, date '2030-12-31', jsonb_build_object('company_prefix', 'NGS'))
  returning id into v_co;

  insert into public.branches (company_id, name) values (v_co, 'Lahore') returning id into v_region;

  insert into public.clients (company_id, name, branch_id) values (v_co, 'Aurora Business Park', v_region) returning id into v_aurora;
  insert into public.clients (company_id, name, branch_id) values (v_co, 'Riverside Medical Centre', v_region) returning id into v_river;

  insert into public.sites (company_id, client_id, name, location, is_default, geo_lat, geo_lng, geo_radius_m)
  values (v_co, v_aurora, 'Tower A', 'Gulberg III, Lahore', true, 31.5120, 74.3440, 150) returning id into v_s1;
  insert into public.sites (company_id, client_id, name, location, is_default, geo_lat, geo_lng, geo_radius_m)
  values (v_co, v_aurora, 'Tower B', 'Gulberg III, Lahore', false, 31.5126, 74.3449, 150) returning id into v_s2;
  insert into public.sites (company_id, client_id, name, location, is_default, geo_lat, geo_lng, geo_radius_m)
  values (v_co, v_river, 'Main Gate', 'Johar Town, Lahore', true, 31.4697, 74.2728, 150) returning id into v_s3;

  -- The supervisor: office staff, so not a guard on any roster.
  insert into public.employees (company_id, full_name, employee_code, category, phone, shift, status)
  values (v_co, 'Asif Nadeem', 'NGS-001', 'office_staff', '0300-0000001', 'day', 'Active')
  returning id into v_sup;

  for r in select * from (values
      ('NGS-101', 'Ahmed Raza',      'day',   1), ('NGS-102', 'Bilal Khan',     'day',   1),
      ('NGS-103', 'Usman Ali',       'night', 1), ('NGS-104', 'Imran Shah',     'night', 1),
      ('NGS-105', 'Kashif Mehmood',  'day',   2), ('NGS-106', 'Naveed Akhtar',  'day',   2),
      ('NGS-107', 'Tariq Hussain',   'night', 2), ('NGS-108', 'Zubair Ahmed',   'day',   3),
      ('NGS-109', 'Faisal Iqbal',    'day',   3), ('NGS-110', 'Waqas Anjum',    'night', 3)
    ) as t(code, name, shift, site)
  loop
    insert into public.employees (company_id, full_name, employee_code, category, phone, shift, status)
    values (v_co, r.name, r.code, 'client', '0300-0000' || right(r.code, 3), r.shift, 'Active')
    returning id into v_g;
    insert into public.deployments (company_id, guard_id, client_id, site_id, start_date, shift_code)
    values (v_co, v_g,
            case when r.site = 3 then v_river else v_aurora end,
            case r.site when 1 then v_s1 when 2 then v_s2 else v_s3 end,
            date '2026-10-01', r.shift);
  end loop;

  -- Logins. Same shape the field-account function and Supabase Auth write.
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values
    ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated', v_admin_email,
     extensions.crypt('__ADMIN_PASSWORD__', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Admin"}', now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_field, 'authenticated', 'authenticated', v_field_email,
     extensions.crypt('Bastion-field:NGS-001:__FIELD_PIN__', extensions.gen_salt('bf')), now(),
     '{"provider":"email","providers":["email"]}', '{"full_name":"Asif Nadeem","field":true}', now(), now(), '', '', '', '');

  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values
    (gen_random_uuid(), v_admin::text, v_admin,
     jsonb_build_object('sub', v_admin::text, 'email', v_admin_email, 'email_verified', true), 'email', null, now(), now()),
    (gen_random_uuid(), v_field::text, v_field,
     jsonb_build_object('sub', v_field::text, 'email', v_field_email, 'email_verified', true), 'email', null, now(), now());

  -- Demo admin: no authenticator required (it holds only this sample company).
  insert into public.profiles (id, company_id, role, full_name, email, permissions, title, must_change_password, mfa_required_from)
  values (v_admin, v_co, 'super_admin', 'Demo Admin', v_admin_email, '{}', 'Demo Administrator', false, null);

  insert into public.profiles (id, company_id, role, title, email, full_name, permissions, user_type,
                               employee_id, site_scope, must_change_password)
  values (v_field, v_co, 'ops_manager', 'Site Supervisor', v_field_email, 'Asif Nadeem', '{}', 'site_supervisor',
          v_sup, array[v_s1, v_s2, v_s3], false);

  -- Assert the result, not the effort.
  select count(*) into v_n from public.sites where company_id = v_co;
  if v_n <> 3 then raise exception 'Expected 3 sites, got %', v_n; end if;
  select count(*) into v_n from public.employees where company_id = v_co and category::text = 'client' and status = 'Active';
  if v_n <> 10 then raise exception 'Expected 10 guards, got %', v_n; end if;
  select count(*) into v_n from public.deployments where company_id = v_co and end_date is null;
  if v_n <> 10 then raise exception 'Expected 10 open deployments, got %', v_n; end if;
  select count(*) into v_n from public.profiles where company_id = v_co;
  if v_n <> 2 then raise exception 'Expected 2 logins, got %', v_n; end if;
end $$;

select c.id as company_id, c.name,
       (select count(*) from public.sites s where s.company_id = c.id) as sites,
       (select count(*) from public.employees e where e.company_id = c.id) as employees,
       (select count(*) from public.deployments d where d.company_id = c.id) as deployments,
       (select string_agg(p.email || ' (' || coalesce(p.user_type, p.role::text) || ')', ', ') from public.profiles p where p.company_id = c.id) as logins
  from public.companies c where c.name = 'Northgate Security (Demo)';
