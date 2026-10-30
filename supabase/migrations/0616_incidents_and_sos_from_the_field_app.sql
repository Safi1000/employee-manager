-- 0616 — incidents and SOS from the field app
--
-- 30 Oct 2026 bundle. An incident reported on the phone lands in the SAME
-- incidents table the Incidents screen already lists (Operations › Incidents),
-- so the office works it there — status, client notified, corrective action —
-- exactly as one it typed itself. Nothing about an incident's life after it is
-- reported moves to the phone.
--
-- incidents was built for posts (empty on 30 Oct, as is incidents itself). It
-- gains site_id, who reported it from the app, the position, and is_sos.
--
--   field_report_incident(site, category, severity, description, guards, photos, geo)
--       category and severity are the table's own enums; guards must be posted
--       at the site; high / critical alert as a warning, the rest as info.
--   field_sos(site, note, geo)
--       one tap: a critical incident flagged SOS and a warning alert that starts
--       "SOS". It reaches Bastion's alert bell — NOT a phone call or SMS. Said
--       to Shayan in the report: if SOS must ring someone's phone, that is a
--       separate piece (SMS gateway or push) and is not in this file.
--   field_site_incidents(site)   the last 30 days at one site, for the phone.
--
-- Asserted under a sentinel: a supervisor reports an incident with a guard and a
-- photo and it alerts; an SOS records a critical SOS incident and alerts; a guard
-- from another site, an unknown category and another site are refused by message.

alter table public.incidents add column if not exists site_id uuid references public.sites (id);
alter table public.incidents add column if not exists source text not null default 'web' check (source in ('web', 'app'));
alter table public.incidents add column if not exists reported_by uuid references public.profiles (id);
alter table public.incidents add column if not exists reporter_name text;
alter table public.incidents add column if not exists geo jsonb;
alter table public.incidents add column if not exists is_sos boolean not null default false;
create index if not exists incidents_site on public.incidents (site_id, occurred_at desc);
comment on column public.incidents.is_sos is
  '0616: raised by the SOS button in the field app. An SOS reaches Bastion''s alerts, not a phone call or SMS.';

create or replace function public.field_report_incident(
  p_site_id uuid, p_category text, p_severity text, p_description text,
  p_guard_ids uuid[] default '{}', p_photos text[] default '{}', p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0616. An incident at one site from the field app, into the incidents table the office works.
  declare v_me record; v_site record; v_roster uuid[]; v_id uuid; v_code text; v_geo jsonb; x uuid;
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_category is null or not (p_category = any (enum_range(null::public.incident_category)::text[])) then
      raise exception 'Choose what kind of incident it was.';
    end if;
    if p_severity is null or not (p_severity = any (enum_range(null::public.incident_severity)::text[])) then
      raise exception 'Choose how serious it is.';
    end if;
    if nullif(btrim(p_description), '') is null then raise exception 'Say what happened.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.id, s.name, s.client_id into v_site from public.sites s where s.id = p_site_id;
    select coalesce(array_agg(r.employee_id), '{}') into v_roster from public.field_site_roster(p_site_id) r;
    if exists (select 1 from unnest(coalesce(p_guard_ids, '{}')) g where not (g = any (v_roster))) then
      raise exception 'That guard is not posted at this site.' using errcode = '42501';
    end if;

    v_geo := public.field_geo(p_site_id, p_geo);
    insert into public.incidents (company_id, occurred_at, client_id, site_id, severity, category, description, status,
                                  source, reported_by, reporter_name, geo, is_sos)
    values (public.current_company_id(), now(), v_site.client_id, p_site_id, p_severity::public.incident_severity,
            p_category::public.incident_category, btrim(p_description), 'open', 'app', v_me.id, v_me.name, v_geo, false)
    returning id, incident_code into v_id, v_code;
    foreach x in array coalesce(p_guard_ids, '{}') loop
      insert into public.incident_guards (incident_id, employee_id) values (v_id, x) on conflict do nothing;
    end loop;
    perform public.field_store_photos(p_site_id, 'incident', 'incidents', v_id, p_photos, v_geo);

    perform public.raise_alert(public.current_company_id(),
      case when p_severity in ('high', 'critical') then 'warning' else 'dashboard' end::public.alert_tier, 'incident',
      v_site.name || ': ' || v_me.name || ' reported ' || replace(p_category, '_', ' ') || ' (' || p_severity || ')'
        || coalesce(' — ' || v_code, '') || '. Open it in Operations › Incidents.',
      'incidents', v_id, null);
    return jsonb_build_object('id', v_id, 'code', v_code);
  end $$;
comment on function public.field_report_incident(uuid, text, text, text, uuid[], text[], jsonb) is
  '0616: an incident from the field app into incidents (source app). Guards must be posted at the site. Alerts: high/critical as warning, else info.';

create or replace function public.field_sos(p_site_id uuid, p_note text default null, p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0616. SOS: a critical incident flagged SOS and a warning alert. Reaches Bastion, not a phone.
  declare v_me record; v_site record; v_id uuid; v_geo jsonb;
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.id, s.name, s.client_id into v_site from public.sites s where s.id = p_site_id;
    v_geo := public.field_geo(p_site_id, p_geo);
    insert into public.incidents (company_id, occurred_at, client_id, site_id, severity, category, description, status,
                                  source, reported_by, reporter_name, geo, is_sos)
    values (public.current_company_id(), now(), v_site.client_id, p_site_id, 'critical', 'other',
            'SOS from ' || v_me.name || coalesce(': ' || nullif(btrim(p_note), ''), ''), 'open', 'app', v_me.id, v_me.name, v_geo, true)
    returning id into v_id;
    perform public.raise_alert(public.current_company_id(), 'warning', 'sos',
      'SOS — ' || v_site.name || ': ' || v_me.name || ' needs help now' || coalesce(' (' || nullif(btrim(p_note), '') || ')', '')
        || case when v_geo is null then '' else '. Position: ' || (v_geo ->> 'lat') || ', ' || (v_geo ->> 'lng') end || '.',
      'incidents', v_id, null);
    return jsonb_build_object('id', v_id);
  end $$;
comment on function public.field_sos(uuid, text, jsonb) is
  '0616: SOS from the field app — a critical incident (is_sos) and a warning alert. Reaches Bastion''s alerts, not a call or SMS.';

create or replace function public.field_site_incidents(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0616. The last 30 days of incidents at one site, for the phone. No photos.
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', i.id, 'code', i.incident_code, 'at', i.occurred_at, 'category', i.category, 'severity', i.severity,
              'status', i.status, 'description', i.description, 'is_sos', i.is_sos, 'reporter_name', i.reporter_name)
              order by i.occurred_at desc), '[]'::jsonb)
              from public.incidents i
             where i.site_id = p_site_id and i.occurred_at >= now() - interval '30 days');
  end $$;
comment on function public.field_site_incidents(uuid) is '0616: the last 30 days of incidents at a site the caller can see.';

revoke all on function public.field_report_incident(uuid, text, text, text, uuid[], text[], jsonb) from public, anon;
grant execute on function public.field_report_incident(uuid, text, text, text, uuid[], text[], jsonb) to authenticated;
revoke all on function public.field_sos(uuid, text, jsonb) from public, anon;
grant execute on function public.field_sos(uuid, text, jsonb) to authenticated;
revoke all on function public.field_site_incidents(uuid) from public, anon;
grant execute on function public.field_site_incidents(uuid) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_report_incident', null, 'EXEMPT 0616: field_can_see_site checked inside'),
  ('field_sos', null, 'EXEMPT 0616: field_can_see_site checked inside'),
  ('field_site_incidents', null, 'EXEMPT 0616: field_can_see_site checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_guard uuid; v_stranger uuid; v_other_site uuid; v_res jsonb; v_msg text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id into v_guard from public.field_site_roster(v_site) r order by r.full_name limit 1;
    select s.id, r.employee_id into v_other_site, v_stranger from public.sites s cross join lateral public.field_site_roster(s.id) r
     where s.id <> v_site and s.company_id = v_co order by s.name limit 1;
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    v_res := public.field_report_incident(v_site, 'altercation', 'high', 'Argument at the gate', array[v_guard], array[v_jpeg], '{"lat": 33.6, "lng": 73.0}');
    if not exists (select 1 from public.incidents where id = (v_res ->> 'id')::uuid and source = 'app' and site_id = v_site and reported_by = v_hr
                    and status = 'open' and severity = 'high' and category = 'altercation' and not is_sos and client_id is not null)
       or not exists (select 1 from public.incident_guards where incident_id = (v_res ->> 'id')::uuid and employee_id = v_guard)
       or (select count(*) from public.field_photos where ref_table = 'incidents' and ref_id = (v_res ->> 'id')::uuid) <> 1
       or not exists (select 1 from public.alerts where ref_table = 'incidents' and ref_id = (v_res ->> 'id')::uuid and category = 'incident' and tier = 'warning') then
      raise exception '0616 REFUSED: the incident, its guard, its photo or its alert is missing: %.', v_res;
    end if;

    v_res := public.field_sos(v_site, 'Intruder', '{"lat": 33.6, "lng": 73.0}');
    if not exists (select 1 from public.incidents where id = (v_res ->> 'id')::uuid and is_sos and severity = 'critical')
       or not exists (select 1 from public.alerts where ref_table = 'incidents' and ref_id = (v_res ->> 'id')::uuid and category = 'sos' and message like 'SOS — %') then
      raise exception '0616 REFUSED: the SOS incident or its alert is missing.';
    end if;
    if jsonb_array_length(public.field_site_incidents(v_site)) < 2 then raise exception '0616 REFUSED: field_site_incidents does not list both.'; end if;

    v_msg := null; begin perform public.field_report_incident(v_site, 'theft', 'low', 'x', array[v_stranger], '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That guard is not posted at this site.' then raise exception '0616 REFUSED: a guard of another site got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_report_incident(v_site, 'ufo', 'low', 'x', '{}', '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Choose what kind of incident it was.' then raise exception '0616 REFUSED: an unknown category got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_sos(v_other_site, null, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0616 REFUSED: SOS at another site got "%".', v_msg; end if;
    raise exception '0616-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0616-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0616 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0616 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
