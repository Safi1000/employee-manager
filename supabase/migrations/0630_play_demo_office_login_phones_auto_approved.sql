-- 0630 — the Play Store demo OFFICE login's phones are approved on arrival too
--
-- Why. Play Console's App access declaration has to say the sign-in details
-- reach ALL the app's features. 0629's supervisor login (NGS-001) reaches the
-- supervisor screens only; the office screens (visits, incidents, expenses,
-- trips, staff files) need an office login. The demo company's own super admin,
-- demo-admin@techxserve.com, is that login: super admins hold field.app
-- (has_perm), it has no authenticator requirement (seed-play-demo.sql), and it
-- reaches only "Northgate Security (Demo)", which holds invented data only.
-- Its phones, like every office login's on the field app (0612), would wait
-- for approval, and Google's reviewer cannot ask for it.
--
-- What. A second BEFORE INSERT trigger on field_devices, for that ONE login,
-- identified by company, role super_admin and email. 0629's function is not
-- restated: a separate function keeps 0629's text the only text of its own.
-- Every other login — every GGS login — is untouched.
--
-- As with 0629: on a phone's first sign-in field_register_device still answers
-- 'pending' once; "Check again" then reads 'active'.
--
-- Risk accepted. The password is given to Google's reviewers. It reaches the
-- demo company only (company separation is enforced by the database), and
-- that company holds no real data.
--
-- Idempotent: create or replace, drop trigger if exists, update only touches
-- rows not already active.

create or replace function public.field_devices_auto_approve_play_demo_office()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
  -- 0630. The Play Store demo office login only (see the migration header).
begin
  if new.status = 'pending' and exists (
       select 1 from public.profiles p
        where p.id = new.user_id
          and p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
          and p.role = 'super_admin'
          and p.email = 'demo-admin@techxserve.com') then
    new.status := 'active';
    new.decided_at := now();
  end if;
  return new;
end $$;

comment on function public.field_devices_auto_approve_play_demo_office() is
  'DECIDED 2 Nov 2026 (Shayan): phones signing in to the field app as the Play Store demo office login (demo-admin@techxserve.com, Northgate Security (Demo)) are approved on arrival, so Google''s reviewer can reach the office screens. That one login only. 0630; the supervisor twin is 0629.';

revoke all on function public.field_devices_auto_approve_play_demo_office() from public, anon, authenticated;

drop trigger if exists trg_field_devices_auto_approve_play_demo_office on public.field_devices;
create trigger trg_field_devices_auto_approve_play_demo_office
  before insert on public.field_devices
  for each row execute function public.field_devices_auto_approve_play_demo_office();

update public.field_devices d
   set status = 'active', decided_at = now()
  from public.profiles p
 where p.id = d.user_id
   and p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
   and p.role = 'super_admin'
   and p.email = 'demo-admin@techxserve.com'
   and d.status = 'pending';

-- The failure to guard against: the rule matching more than the one demo login.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.profiles p
   where p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
     and p.role = 'super_admin'
     and p.email = 'demo-admin@techxserve.com';
  if v_n <> 1 then
    raise exception '0630: the auto-approve rule matches % logins, expected exactly 1 (the Play demo office login).', v_n;
  end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0630 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0630 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0630 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $$;
