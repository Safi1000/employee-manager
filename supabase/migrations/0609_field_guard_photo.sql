-- 0609 — the field app shows a guard's photo
--
-- 0607 promised supervisors a photo of each guard at their sites and shipped
-- has_photo only; the app showed initials. Photos live in employees.photo_url
-- as a data URL (Edit Employee resizes and stores them there; buckets are
-- private), so no Edge Function is needed — one field_* function the API gate
-- already lets a supervisor call.
--
--   field_guard_photo(site, guard)  the guard's photo_url, only when the guard
--                                   is on field_site_roster(site) — which
--                                   itself refuses a site the caller does not
--                                   cover. One photo per call: the roster stays
--                                   small and a phone fetches only what it shows.
--
-- As of 30 Oct 2026 no employee has a photo (0 of 695), so the app shows
-- initials everywhere until photos are uploaded in Edit Employee.
--
-- Asserted with the HR login made a supervisor of Emaar DHA ISB and a photo
-- given to one Emaar guard for the test (rolled back by a sentinel whose
-- message is checked): that guard's photo comes back; a guard not on the
-- roster and another site's guard are refused with "Row not found"; no
-- security, tenant or branch gap.

create or replace function public.field_guard_photo(p_site_id uuid, p_employee_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0609. One guard's photo, only for a guard on one of the caller's site rosters.
  declare v_photo text;
  begin
    -- tenant guard [resolved]: the site's and the guard's company; then field_site_roster checks the caller's own sites.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    perform public.assert_same_company((select e.company_id from public.employees e where e.id = p_employee_id));
    if not exists (select 1 from public.field_site_roster(p_site_id) r where r.employee_id = p_employee_id) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    select nullif(btrim(e.photo_url), '') into v_photo from public.employees e where e.id = p_employee_id;
    return v_photo;
  end $$;
comment on function public.field_guard_photo(uuid, uuid) is
  '0609: a guard''s photo for the field app — only a guard on field_site_roster(site), which refuses a site the caller does not cover.';

revoke all on function public.field_guard_photo(uuid, uuid) from public, anon;
grant execute on function public.field_guard_photo(uuid, uuid) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_guard_photo', null, 'EXEMPT 0609: a guard on the caller''s own site roster, checked inside')
on conflict (function_name) do nothing;

do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_emaar uuid := (select s.id from public.sites s join public.clients c on c.id = s.client_id
                    where s.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and c.name = 'Emaar DHA ISB' limit 1);
  v_other uuid; v_on uuid; v_off uuid; v_msg text; v_got text;
begin
  if v_emaar is null then raise exception '0609 REFUSED: no Emaar site to test with.'; end if;
  begin
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_emaar] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    select r.employee_id into v_on from public.field_site_roster(v_emaar) r limit 1;
    if v_on is null then raise exception '0609 REFUSED: the Emaar roster is empty.'; end if;
    update public.employees set photo_url = 'data:image/jpeg;base64,MDYwOQ==' where id = v_on;
    v_got := public.field_guard_photo(v_emaar, v_on);
    if v_got is distinct from 'data:image/jpeg;base64,MDYwOQ==' then raise exception '0609 REFUSED: the roster guard''s photo came back as "%".', left(v_got, 40); end if;

    select e.id into v_off from public.employees e
     where e.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
       and e.id not in (select r.employee_id from public.field_site_roster(v_emaar) r) limit 1;
    v_msg := null; begin perform public.field_guard_photo(v_emaar, v_off); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0609 REFUSED: a guard not on the roster said "%".', v_msg; end if;

    select s.id into v_other from public.sites s where s.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and s.id <> v_emaar limit 1;
    v_msg := null; begin perform public.field_guard_photo(v_other, v_on); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0609 REFUSED: another site said "%".', v_msg; end if;
    raise exception '0609-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0609-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0609 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0609 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name ~ 'field') then raise exception '0609 REFUSED: branch_guard_gaps() reports a field function.'; end if;
end $test$;
