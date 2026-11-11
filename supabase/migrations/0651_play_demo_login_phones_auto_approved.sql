-- 0629 — the Play Store demo login's phones are approved on arrival
--
-- Why. Google's reviewer signs in to GGS Field with the demo company's
-- supervisor login (NGS-001, "Northgate Security (Demo)", seeded 2 Nov 2026 by
-- scripts/seed-play-demo.sql). Every field phone waits for a super admin's
-- approval (0611), and Google's reviewers cannot contact us, so a review phone
-- left on "Waiting for the office" fails the review — again on every update.
--
-- What. A BEFORE INSERT trigger on field_devices sets status 'active' when the
-- phone belongs to that ONE login, identified three ways at once (the demo
-- company, user_type site_supervisor, and its email). Every other login —
-- every GGS login — is untouched: the trigger returns the row unchanged.
-- Phones already registered on the demo login are approved by the same rule.
--
-- Why a trigger and not an edit to field_register_device: that function has
-- been edited by 0607, 0611, 0612, 0613, 0619, 0620 and 0625, so no file holds
-- its true text (CLAUDE.md, "a function edited by more than one migration").
-- The trigger leaves it alone. Consequence: on a phone's FIRST sign-in the
-- function still answers 'pending' (it returns the literal it inserted), so the
-- app shows "Waiting for the office" once; "Check again" then reads 'active'.
-- The Play access instructions say to tap it.
--
-- Risk accepted. Anyone holding NGS-001's PIN can use it on any phone. The
-- login reaches only the demo company, which holds invented data only, and
-- the field gate (0607) still confines it to the field_* functions.
--
-- Idempotent: create or replace, drop trigger if exists, and the update only
-- touches rows not already active.

create or replace function public.field_devices_auto_approve_play_demo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
  -- 0629. The Play Store demo login only (see the migration header). A definer
  -- trigger: it fires inside an insert the caller already passed RLS to make.
begin
  if new.status = 'pending' and exists (
       select 1 from public.profiles p
        where p.id = new.user_id
          and p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
          and p.user_type = 'site_supervisor'
          and p.email = 'ngs-001@field.techxserve.com') then
    new.status := 'active';
    new.decided_at := now();
  end if;
  return new;
end $$;

comment on function public.field_devices_auto_approve_play_demo() is
  'DECIDED 2 Nov 2026 (Shayan): phones signing in as the Play Store demo login (NGS-001, Northgate Security (Demo)) are approved on arrival so Google''s reviewer is not stuck waiting. That one login only; every other login still waits for a super admin (0611). 0629.';

-- A trigger function: nobody calls it directly.
revoke all on function public.field_devices_auto_approve_play_demo() from public, anon, authenticated;

drop trigger if exists trg_field_devices_auto_approve_play_demo on public.field_devices;
create trigger trg_field_devices_auto_approve_play_demo
  before insert on public.field_devices
  for each row execute function public.field_devices_auto_approve_play_demo();

update public.field_devices d
   set status = 'active', decided_at = now()
  from public.profiles p
 where p.id = d.user_id
   and p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
   and p.user_type = 'site_supervisor'
   and p.email = 'ngs-001@field.techxserve.com'
   and d.status = 'pending';

-- The failure to guard against: the rule matching more than the one demo login
-- (or none). Count the logins it matches; it must be exactly one.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.profiles p
   where p.company_id = '4aad5d7a-8dc6-40ef-90bb-7d8b366b0261'
     and p.user_type = 'site_supervisor'
     and p.email = 'ngs-001@field.techxserve.com';
  if v_n <> 1 then
    raise exception '0629: the auto-approve rule matches % logins, expected exactly 1 (the Play demo login).', v_n;
  end if;
  if exists (select 1 from public.security_gaps()) then raise exception '0629 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0629 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0629 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $$;
