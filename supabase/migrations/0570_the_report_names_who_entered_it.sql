-- 0570 — the daily report names who entered it, whoever exports it
--
-- DECIDED 2026-10-28 (Shayan): the daily report PDF names the people who
-- ENTERED what it reports — the client notes, updates and tasks (updated_by)
-- and the attendance (marked_by_user_id) — and the exporter only as
-- "Extracted by": "i did nothing i just extracted". And: "i dont export the
-- report Gul Rahman does".
--
-- The screen reads those names from profiles, whose SELECT policies let a
-- user read only himself unless he is a super admin. Gul Rahman exporting
-- would print "Unknown user" for everyone else. This function returns the
-- names — id and full_name, nothing else — of the users asked for, only
-- within the caller's own company, to anyone who can open Daily Reports
-- (the route's keys: roster.view, roster.edit, incidents.view,
-- attendance.view). No new permission key.
--
-- Read-only, single statement, no company parameter (the company is the
-- caller's own), so nothing for tenant_guard_gaps or branch_guard_gaps.

create or replace function public.report_author_names(p_ids uuid[])
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.has_perm('roster.view') or public.has_perm('roster.edit')
          or public.has_perm('incidents.view') or public.has_perm('attendance.view')) then
    raise exception 'report_author_names: not permitted — needs access to Daily Reports.';
  end if;
  return query
    select p.id, p.full_name::text
      from public.profiles p
     where p.id = any (p_ids)
       and p.company_id = public.current_company_id();
end $$;

comment on function public.report_author_names(uuid[]) is
  '0570: names (id, full_name only) of the given users in the caller''s company, for the daily report''s "Prepared by" / "Attendance marked by" — profiles RLS hides other users from non-super-admins. Gated on the Daily Reports route keys.';

revoke all on function public.report_author_names(uuid[]) from public, anon;
grant execute on function public.report_author_names(uuid[]) to authenticated;

do $$
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name = 'report_author_names')
     or exists (select 1 from public.branch_guard_gaps() where function_name = 'report_author_names') then
    raise exception '0570 REFUSED: report_author_names shows up as a guard gap.';
  end if;
end $$;
