-- 0615 — site visits with a checklist, from the field app
--
-- DECIDED 28 Oct 2026 (plan) and 30 Oct (build): a supervisor visits his own
-- sites; an office login with field.app (Zamir, Safar sb, Nauman, the CEO —
-- "field officers") visits any site it can see. The checklist is the one put to
-- Shayan on 28 Oct and accepted as the base:
--   per guard on duty — present, awake and alert, uniform, ID card, weapon and
--                       licence, ammunition, on the right post;
--   the site          — duty register kept up.
-- Each point is yes / no / not applicable (an unarmed guard has no weapon to
-- check). A "no" anywhere needs at least one photo, taken from the camera — the
-- app offers no gallery, so a photo cannot be recycled from last week.
--
-- supervisor_visits (0 rows on 30 Oct, no screen) is the table. It was built for
-- posts, which are empty too; it gains site_id and the visitor, and post_id stops
-- being required. Its photo_url / drive_* columns stay unused: photos go to
-- field_photos (0614).
--
--   field_record_visit(site, guards, site_checks, findings, actions, photos, geo)
--   field_site_visits(site)       the last 30 days at one site, for the phone.
--
-- A visit with any "no" raises an alert naming the site and the count, so the
-- office sees it the day it happens.
--
-- Asserted under a sentinel: a supervisor records a clean visit and one with a
-- failure and a photo; a failure without a photo, a guard from another site, an
-- unknown point and another site are refused by message; the alert is raised; an
-- office login records a visit at a site no supervisor of its own covers.

alter table public.supervisor_visits alter column post_id drop not null;
alter table public.supervisor_visits add column if not exists site_id uuid references public.sites (id);
alter table public.supervisor_visits add column if not exists visitor_id uuid references public.profiles (id);
alter table public.supervisor_visits add column if not exists visitor_name text;
alter table public.supervisor_visits add column if not exists visitor_kind text check (visitor_kind in ('supervisor', 'office'));
alter table public.supervisor_visits add column if not exists checklist jsonb;
alter table public.supervisor_visits add column if not exists guards_checked integer;
alter table public.supervisor_visits add column if not exists issues integer;
alter table public.supervisor_visits add column if not exists geo jsonb;
alter table public.supervisor_visits add column if not exists source text not null default 'web' check (source in ('web', 'app'));
create index if not exists supervisor_visits_site on public.supervisor_visits (site_id, completed_at desc);
comment on table public.supervisor_visits is
  '0615: a visit to a site with its checklist — from the field app (source app) by the site''s supervisor or an office login with field.app. checklist = {guards: [{employee_id, full_name, checks: {present, alert, uniform, id_card, weapon, ammunition, right_post}, note}], site: {duty_register}}; each check true / false / null (n/a). Photos in field_photos (ref_table supervisor_visits). post_id / photo_url / drive_* are the pre-0615 design and unused.';

create or replace function public.field_record_visit(
  p_site_id uuid, p_guards jsonb, p_site_checks jsonb, p_findings text, p_actions text,
  p_photos text[] default '{}', p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0615. A visit to one site: per-guard checklist, site checks, findings, photos, position.
  declare
    v_guard_keys constant text[] := array['present', 'alert', 'uniform', 'id_card', 'weapon', 'ammunition', 'right_post'];
    v_site_keys  constant text[] := array['duty_register'];
    v_me record; v_site record; v_roster uuid[]; g jsonb; k text; v_issues int := 0; v_n int := 0;
    v_list jsonb := '[]'::jsonb; v_checks jsonb; v_id uuid; v_geo jsonb; v_sup boolean := public.is_site_supervisor();
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site checks the caller may see it.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.id, s.name, s.client_id, c.branch_id into v_site from public.sites s left join public.clients c on c.id = s.client_id where s.id = p_site_id;
    select coalesce(array_agg(r.employee_id), '{}') into v_roster from public.field_site_roster(p_site_id) r;

    if p_guards is null or jsonb_typeof(p_guards) <> 'array' or jsonb_array_length(p_guards) = 0 then
      raise exception 'Check at least one guard.';
    end if;
    for g in select x from jsonb_array_elements(p_guards) x loop
      if not ((g ->> 'employee_id')::uuid = any (v_roster)) then raise exception 'That guard is not posted at this site.' using errcode = '42501'; end if;
      v_checks := coalesce(g -> 'checks', '{}'::jsonb);
      for k in select jsonb_object_keys(v_checks) loop
        if not (k = any (v_guard_keys)) or jsonb_typeof(v_checks -> k) not in ('boolean', 'null') then
          raise exception 'Unknown checklist point "%".', k;
        end if;
        if v_checks -> k = 'false'::jsonb then v_issues := v_issues + 1; end if;
      end loop;
      v_n := v_n + 1;
      v_list := v_list || jsonb_build_object(
        'employee_id', g ->> 'employee_id',
        'full_name', (select e.full_name from public.employees e where e.id = (g ->> 'employee_id')::uuid),
        'checks', v_checks, 'note', nullif(btrim(g ->> 'note'), ''));
    end loop;
    for k in select jsonb_object_keys(coalesce(p_site_checks, '{}'::jsonb)) loop
      if not (k = any (v_site_keys)) or jsonb_typeof(p_site_checks -> k) not in ('boolean', 'null') then
        raise exception 'Unknown checklist point "%".', k;
      end if;
      if p_site_checks -> k = 'false'::jsonb then v_issues := v_issues + 1; end if;
    end loop;
    if v_issues > 0 and coalesce(cardinality(p_photos), 0) = 0 then
      raise exception 'Take a photo of what was wrong before you save.';
    end if;

    v_geo := public.field_geo(p_site_id, p_geo);
    insert into public.supervisor_visits
      (company_id, post_id, client_id, branch_id, site_id, visitor_id, visitor_name, visitor_kind,
       scheduled_date, completed_at, geo_lat, geo_lng, findings, corrective_actions, status,
       checklist, guards_checked, issues, geo, source)
    values (public.current_company_id(), null, v_site.client_id, v_site.branch_id, p_site_id, v_me.id, v_me.name,
            case when v_sup then 'supervisor' else 'office' end,
            public.field_today(), now(), (v_geo ->> 'lat')::numeric, (v_geo ->> 'lng')::numeric,
            nullif(btrim(p_findings), ''), nullif(btrim(p_actions), ''), 'completed',
            jsonb_build_object('guards', v_list, 'site', coalesce(p_site_checks, '{}'::jsonb)), v_n, v_issues, v_geo, 'app')
    returning id into v_id;
    perform public.field_store_photos(p_site_id, 'visit', 'supervisor_visits', v_id, p_photos, v_geo);

    if v_issues > 0 then
      perform public.raise_alert(public.current_company_id(), 'dashboard', 'field',
        v_site.name || ': ' || v_me.name || '''s visit found ' || v_issues || ' point' || case when v_issues = 1 then '' else 's' end
          || ' wrong. Open it in Operations › Field Supervisors › Visits.',
        'supervisor_visits', v_id, v_site.branch_id);
    end if;
    return jsonb_build_object('id', v_id, 'guards_checked', v_n, 'issues', v_issues,
                              'inside', v_geo -> 'inside', 'distance_m', v_geo -> 'distance_m');
  end $$;
comment on function public.field_record_visit(uuid, jsonb, jsonb, text, text, text[], jsonb) is
  '0615: a site visit from the field app — the caller''s own site (supervisor) or any site field_can_see_site allows (office, field.app). A "no" needs a photo; any "no" alerts. Position recorded, never refused.';

create or replace function public.field_site_visits(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0615. The last 30 days of visits at one site, for the phone. No photos.
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', v.id, 'at', v.completed_at, 'visitor_name', v.visitor_name, 'visitor_kind', v.visitor_kind,
              'guards_checked', v.guards_checked, 'issues', v.issues, 'findings', v.findings,
              'inside', v.geo -> 'inside') order by v.completed_at desc), '[]'::jsonb)
              from public.supervisor_visits v
             where v.site_id = p_site_id and v.completed_at >= now() - interval '30 days');
  end $$;
comment on function public.field_site_visits(uuid) is '0615: the last 30 days of visits at a site the caller can see.';

revoke all on function public.field_record_visit(uuid, jsonb, jsonb, text, text, text[], jsonb) from public, anon;
grant execute on function public.field_record_visit(uuid, jsonb, jsonb, text, text, text[], jsonb) to authenticated;
revoke all on function public.field_site_visits(uuid) from public, anon;
grant execute on function public.field_site_visits(uuid) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_record_visit', null, 'EXEMPT 0615: field_can_see_site checked inside'),
  ('field_site_visits', null, 'EXEMPT 0615: field_can_see_site checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_guard uuid; v_stranger uuid; v_other_site uuid; v_res jsonb; v_msg text; v_ok jsonb;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id into v_guard from public.field_site_roster(v_site) r order by r.full_name limit 1;
    select s.id, r.employee_id into v_other_site, v_stranger from public.sites s cross join lateral public.field_site_roster(s.id) r
     where s.id <> v_site and s.company_id = v_co order by s.name limit 1;
    v_ok := jsonb_build_object('present', true, 'alert', true, 'uniform', true, 'id_card', true, 'weapon', null, 'ammunition', null, 'right_post', true);

    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    v_res := public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', v_ok)),
                                       '{"duty_register": true}', 'All fine', null, '{}', '{"lat": 33.6, "lng": 73.0}');
    if (v_res ->> 'issues')::int <> 0 or not exists (select 1 from public.supervisor_visits where id = (v_res ->> 'id')::uuid
         and visitor_kind = 'supervisor' and source = 'app' and status = 'completed' and guards_checked = 1 and site_id = v_site) then
      raise exception '0615 REFUSED: a clean visit recorded %.', v_res;
    end if;

    v_msg := null; begin perform public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', v_ok || '{"uniform": false}')), '{}', null, null, '{}', null);
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Take a photo of what was wrong before you save.' then raise exception '0615 REFUSED: a failure with no photo got "%".', v_msg; end if;

    v_res := public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', v_ok || '{"uniform": false}', 'note', 'No cap')),
                                       '{"duty_register": false}', 'Two wrong', 'Cap issued', array[v_jpeg], null);
    if (v_res ->> 'issues')::int <> 2
       or (select count(*) from public.field_photos where ref_table = 'supervisor_visits' and ref_id = (v_res ->> 'id')::uuid and kind = 'visit') <> 1
       or not exists (select 1 from public.alerts where ref_table = 'supervisor_visits' and ref_id = (v_res ->> 'id')::uuid and category = 'field') then
      raise exception '0615 REFUSED: a visit with two failures and a photo recorded %, or no photo, or no alert.', v_res;
    end if;

    v_msg := null; begin perform public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_stranger, 'checks', v_ok)), '{}', null, null, '{}', null);
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That guard is not posted at this site.' then raise exception '0615 REFUSED: a guard of another site got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', '{"asleep": true}'::jsonb)), '{}', null, null, '{}', null);
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Unknown checklist point "asleep".' then raise exception '0615 REFUSED: an unknown point got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_record_visit(v_other_site, jsonb_build_array(jsonb_build_object('employee_id', v_stranger, 'checks', v_ok)), '{}', null, null, '{}', null);
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0615 REFUSED: another site got "%".', v_msg; end if;
    if jsonb_array_length(public.field_site_visits(v_site)) <> 2 then raise exception '0615 REFUSED: field_site_visits does not list the two visits.'; end if;

    -- an office login (field.app via super admin) visits another site
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_res := public.field_record_visit(v_other_site, jsonb_build_array(jsonb_build_object('employee_id', v_stranger, 'checks', v_ok)), '{}', null, null, '{}', null);
    if not exists (select 1 from public.supervisor_visits where id = (v_res ->> 'id')::uuid and visitor_kind = 'office' and visitor_id = v_boss) then
      raise exception '0615 REFUSED: an office visit was not recorded as office.';
    end if;
    raise exception '0615-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0615-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0615 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0615 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
