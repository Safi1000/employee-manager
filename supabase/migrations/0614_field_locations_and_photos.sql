-- 0614 — field app: where a site is, and the photos a phone sends
--
-- Shayan, 30 Oct 2026: "add everything so that I can test everything at once".
-- This file is the floor the rest of that bundle (0615–0619) stands on.
--
-- WHERE A SITE IS. sites gains geo_lat / geo_lng / geo_radius_m. Shayan supplies
-- them (DECIDED 30 Oct): a point from Google Maps and a rough area — "Emaar
-- covers around 50 km, HMC even bigger, Nova ISB is one building, Nova Peshawar
-- is bigger". So the radius is per site and can be tens of kilometres. A site
-- with no point is simply not checked: field_geo() reports inside = null, never
-- false, because "nobody has said where this is" is not "he was somewhere else".
--
-- The phone's position is RECORDED and COMPARED, never used to refuse. Cheap
-- Android GPS indoors is off by hundreds of metres; a refusal there would stop a
-- supervisor confirming attendance he is standing in front of. Every app
-- submission that carries a position stores the distance and whether it was
-- inside, and the office sees "outside the site's area" on the record.
--
--   admin_set_site_location   super admin: point + radius, or clears it.
--   field_geo(site, geo)      internal: {lat, lng, accuracy_m, distance_m, inside}.
--
-- PHOTOS. No storage bucket. Guard photos already live in employees.photo_url as
-- a resized JPEG data URL (EmployeeManagement: "buckets are private; this keeps
-- the ID card printable"), and the field app already shows them that way. The
-- other photos (visit, incident, SOS, task, daily report) go into field_photos
-- the same way: a data URL the phone has already shrunk, written only by a
-- field_* function, read by office logins of the company and never by a
-- supervisor's API key — the supervisor's gate allows only /rpc/field_*, and
-- there is no field_* function that reads another person's photo.
--
--   field_photos                   kind, ref_table, ref_id, data, who, where.
--   field_store_photos(...)        internal: validates and writes up to 6.
--   field_set_guard_photo(site, guard, data)
--                                  a guard with NO photo gets one from the phone
--                                  (DECIDED 30 Oct: supervisors fill empty photos;
--                                  replacing one stays an office job). On 30 Oct
--                                  0 of 375 active guards had a photo.
--
-- Asserted, rolled back by a sentinel whose message is checked: a site's point
-- and radius give inside/outside at the right distance and null with no point;
-- a supervisor sets a photo on an empty guard and is refused on the same guard
-- again, on a guard of another site, and with something that is not a JPEG.

-- -------------------------------------------------------------- where a site is
alter table public.sites add column if not exists geo_lat numeric(9,6);
alter table public.sites add column if not exists geo_lng numeric(9,6);
alter table public.sites add column if not exists geo_radius_m integer;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'sites_geo_complete') then
    alter table public.sites add constraint sites_geo_complete check (
      (geo_lat is null and geo_lng is null and geo_radius_m is null)
      or (geo_lat between -90 and 90 and geo_lng between -180 and 180 and geo_radius_m between 20 and 200000));
  end if;
end $c$;
comment on column public.sites.geo_lat is
  '0614: the site''s point (with geo_lng) and geo_radius_m its area. DECIDED 30 Oct 2026: Shayan supplies them from Google Maps with a rough area per client (Emaar ~50 km, HMC bigger, Nova ISB one building). Null = not yet said; the field app then records position without comparing.';

create or replace function public.admin_set_site_location(p_site_id uuid, p_lat numeric, p_lng numeric, p_radius_m integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0614. A site's point and area for the field app; all three null clears it.
  declare n int;
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can set where a site is.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the site's company.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if (p_lat is null) <> (p_lng is null) or (p_lat is null) <> (p_radius_m is null) then
      raise exception 'Give the point and the area together, or clear all of them.';
    end if;
    if p_lat is not null and not (p_lat between -90 and 90 and p_lng between -180 and 180) then
      raise exception 'That is not a point on the map. Paste the coordinates from Google Maps, latitude first.';
    end if;
    if p_radius_m is not null and not (p_radius_m between 20 and 200000) then
      raise exception 'The area must be between 20 metres and 200 km.';
    end if;
    update public.sites set geo_lat = p_lat, geo_lng = p_lng, geo_radius_m = p_radius_m, updated_at = now() where id = p_site_id;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Row not found' using errcode = '42501'; end if;
  end $$;
comment on function public.admin_set_site_location(uuid, numeric, numeric, integer) is
  '0614: super admin sets (or clears) a site''s point and radius for the field app''s position check.';
revoke all on function public.admin_set_site_location(uuid, numeric, numeric, integer) from public, anon;
grant execute on function public.admin_set_site_location(uuid, numeric, numeric, integer) to authenticated;

create or replace function public.field_geo(p_site_id uuid, p_geo jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0614. The phone's position against the site's area. inside is null when either is unknown.
  declare v_lat numeric; v_lng numeric; v_acc numeric; s record; v_d numeric;
  begin
    -- tenant guard [resolved]: the site's company.
    perform public.assert_same_company((select x.company_id from public.sites x where x.id = p_site_id));
    if p_geo is null or jsonb_typeof(p_geo) <> 'object' then return null; end if;
    begin
      v_lat := (p_geo ->> 'lat')::numeric; v_lng := (p_geo ->> 'lng')::numeric; v_acc := (p_geo ->> 'accuracy')::numeric;
    exception when others then return null;
    end;
    if v_lat is null or v_lng is null or not (v_lat between -90 and 90 and v_lng between -180 and 180) then return null; end if;
    select geo_lat, geo_lng, geo_radius_m into s from public.sites where id = p_site_id;
    if s.geo_lat is not null then
      -- haversine, metres
      v_d := round(2 * 6371000 * asin(sqrt(
               power(sin(radians(v_lat - s.geo_lat) / 2), 2)
               + cos(radians(s.geo_lat)) * cos(radians(v_lat)) * power(sin(radians(v_lng - s.geo_lng) / 2), 2))));
    end if;
    return jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6), 'accuracy_m', round(v_acc),
                              'distance_m', v_d, 'inside', case when v_d is null then null else v_d <= s.geo_radius_m end);
  end $$;
comment on function public.field_geo(uuid, jsonb) is
  '0614: internal — the phone''s position compared with the site''s point and radius. Recorded, never used to refuse (cheap GPS indoors is off by hundreds of metres).';
revoke all on function public.field_geo(uuid, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------- photos from the phone
create table if not exists public.field_photos (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies (id),
  site_id     uuid references public.sites (id),
  kind        text not null check (kind in ('visit', 'incident', 'sos', 'task', 'daily_report')),
  ref_table   text not null,
  ref_id      uuid not null,
  data        text not null check (data like 'data:image/jpeg;base64,%' and length(data) <= 700000),
  taken_by    uuid not null references public.profiles (id),
  taken_by_name text not null,
  geo         jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists field_photos_ref on public.field_photos (ref_table, ref_id);
comment on table public.field_photos is
  '0614: photos sent from the field app (visit, incident, SOS, task, daily report) as JPEG data URLs the phone has already shrunk. Written only by field_* functions through field_store_photos. Read by office logins of the company; never by a supervisor''s key.';
alter table public.field_photos enable row level security;
drop policy if exists field_photos_read on public.field_photos;
create policy field_photos_read on public.field_photos for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor()));
revoke all on public.field_photos from anon;
grant select on public.field_photos to authenticated;

create or replace function public.field_store_photos(p_site_id uuid, p_kind text, p_ref_table text, p_ref_id uuid, p_photos text[], p_geo jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0614. Internal: validates and stores up to six photos for one field record.
  declare v_name text; x text; n int := 0;
  begin
    -- tenant guard [resolved]: the site's company.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if coalesce(cardinality(p_photos), 0) = 0 then return 0; end if;
    if cardinality(p_photos) > 6 then raise exception 'Send at most six photos at a time.'; end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    foreach x in array p_photos loop
      if x is null or x not like 'data:image/jpeg;base64,%' then raise exception 'A photo did not come through. Take it again.'; end if;
      if length(x) > 700000 then raise exception 'A photo is too large. Take it again.'; end if;
      insert into public.field_photos (company_id, site_id, kind, ref_table, ref_id, data, taken_by, taken_by_name, geo)
      values (public.current_company_id(), p_site_id, p_kind, p_ref_table, p_ref_id, x, auth.uid(), v_name, p_geo);
      n := n + 1;
    end loop;
    return n;
  end $$;
comment on function public.field_store_photos(uuid, text, text, uuid, text[], jsonb) is
  '0614: internal — the field functions'' one way to write field_photos.';
revoke all on function public.field_store_photos(uuid, text, text, uuid, text[], jsonb) from public, anon, authenticated;

create or replace function public.field_set_guard_photo(p_site_id uuid, p_employee_id uuid, p_data text)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0614. A guard on the caller's site with NO photo gets one from the phone.
  declare n int;
  begin
    -- tenant guard [resolved]: the site's and the guard's company; then the caller's own roster.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    perform public.assert_same_company((select e.company_id from public.employees e where e.id = p_employee_id));
    if not exists (select 1 from public.field_site_roster(p_site_id) r where r.employee_id = p_employee_id) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    if p_data is null or p_data not like 'data:image/jpeg;base64,%' or length(p_data) > 400000 then
      raise exception 'The photo did not come through. Take it again.';
    end if;
    -- DECIDED 30 Oct 2026: the phone fills an EMPTY photo; replacing one is the office's.
    update public.employees set photo_url = p_data, updated_at = now()
     where id = p_employee_id and nullif(btrim(photo_url), '') is null;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'He already has a photo. Ask the office to change it.'; end if;
  end $$;
comment on function public.field_set_guard_photo(uuid, uuid, text) is
  '0614: the field app sets the photo of a guard on the caller''s site who has none (DECIDED 30 Oct 2026). Replacing a photo stays with the office.';
revoke all on function public.field_set_guard_photo(uuid, uuid, text) from public, anon;
grant execute on function public.field_set_guard_photo(uuid, uuid, text) to authenticated;

insert into public.api_function_gates (function_name, any_of, reason) values
  ('admin_set_site_location', '{users.manage}', '0614: super admin checked inside'),
  ('field_set_guard_photo', null, 'EXEMPT 0614: field_site_roster (the caller''s own sites) checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_g jsonb; v_msg text; v_guard uuid; v_stranger uuid;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.admin_set_site_location(v_site, 33.600000, 73.000000, 500);
    -- ~0.009 deg latitude is ~1 km: outside a 500 m area, inside a 2 km one
    v_g := public.field_geo(v_site, jsonb_build_object('lat', 33.609, 'lng', 73.0, 'accuracy', 12));
    if (v_g ->> 'inside')::boolean or (v_g ->> 'distance_m')::numeric not between 990 and 1010 then
      raise exception '0614 REFUSED: 1 km away from a 500 m site read %.', v_g;
    end if;
    perform public.admin_set_site_location(v_site, 33.600000, 73.000000, 2000);
    if not (public.field_geo(v_site, jsonb_build_object('lat', 33.609, 'lng', 73.0)) ->> 'inside')::boolean then
      raise exception '0614 REFUSED: 1 km away from a 2 km site was not inside.';
    end if;
    perform public.admin_set_site_location(v_site, null, null, null);
    v_g := public.field_geo(v_site, jsonb_build_object('lat', 33.609, 'lng', 73.0));
    if v_g ->> 'inside' is not null or v_g ->> 'lat' is null then raise exception '0614 REFUSED: a site with no point read %.', v_g; end if;
    if public.field_geo(v_site, null) is not null or public.field_geo(v_site, '{"lat":"x"}') is not null then
      raise exception '0614 REFUSED: no position or a broken one was not null.';
    end if;
    v_msg := null; begin perform public.admin_set_site_location(v_site, 33.6, null, 500); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Give the point and the area together, or clear all of them.' then raise exception '0614 REFUSED: half a location got "%".', v_msg; end if;

    -- a supervisor fills an empty photo, once
    select r.employee_id into v_guard from public.field_site_roster(v_site) r order by r.full_name limit 1;
    select r.employee_id into v_stranger from public.sites s cross join lateral public.field_site_roster(s.id) r where s.id <> v_site and s.company_id = v_co limit 1;
    update public.employees set photo_url = null where id = v_guard;
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.admin_set_site_location(v_site, 33.6, 73.0, 500); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only a super admin can set where a site is.' then raise exception '0614 REFUSED: a supervisor setting a location got "%".', v_msg; end if;
    perform public.field_set_guard_photo(v_site, v_guard, v_jpeg);
    if (select photo_url from public.employees where id = v_guard) is distinct from v_jpeg then raise exception '0614 REFUSED: the photo was not set.'; end if;
    v_msg := null; begin perform public.field_set_guard_photo(v_site, v_guard, v_jpeg); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'He already has a photo. Ask the office to change it.' then raise exception '0614 REFUSED: replacing a photo got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_set_guard_photo(v_site, v_stranger, v_jpeg); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0614 REFUSED: a guard of another site got "%".', v_msg; end if;
    update public.employees set photo_url = null where id = v_guard;
    v_msg := null; begin perform public.field_set_guard_photo(v_site, v_guard, 'data:image/png;base64,AAAA'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The photo did not come through. Take it again.' then raise exception '0614 REFUSED: a PNG got "%".', v_msg; end if;
    raise exception '0614-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0614-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0614 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0614 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
