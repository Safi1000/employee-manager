-- 0623 — trips from the field app (Zafar, Zamir and anyone given field.trips)
--
-- Shayan, 30 Oct 2026: "for Zafar and Zamir to directly input their fuel
-- expenses and GPS tracking (maybe) to record their trip costs". Agreed the
-- same day: no continuous tracking for now (battery, an always-on location
-- permission, and people switch it off). A trip is START — odometer photo and
-- reading, where to, what for — and END — odometer photo and reading. The phone's
-- position is stored at both. Distance is end − start.
--
-- Money stays out of the app (DECIDED 30 Oct: the app's own panel, no two-way
-- link). field_trips holds kilometres, never rupees. The office turns a trip
-- into its cost on the web, in the fuel sheet the cards start using on 1 Nov
-- 2026 (0582: km ÷ the card's km per litre × the petrol price), and marks the
-- app trip "added to the fuel sheet". The trip carries the login's fuel card when
-- the card's holder is the login's employee, so the office knows whose card.
--
--   field_trips                    the app's own trip log (km only)
--   field_trip_state()             the open trip, the last 10, my card, clients
--   field_trip_start(...)          field.trips (new): one open trip at a time; photo required
--   field_trip_end(...)            reading not below the start, under 2,000 km; photo required
--   field_trip_cancel(trip)        an open trip started by mistake
--   mark_field_trip_added(...)     field.money_approve or expenses.edit, on the web
--
-- Asserted under a sentinel: a trip starts with a photo, a second start is
-- refused, ending below the start reading is refused, ending writes km and a
-- field_activity line, the open trip is gone from the state; a supervisor and an
-- office login without the key are refused by message; marking added works once.

insert into public.permission_keys (key, grp, label) values
  ('field.trips', 'Field app', 'Field: record own trips (odometer at start and end)')
on conflict (key) do nothing;

create table if not exists public.field_trips (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies (id),
  driver_id       uuid not null references public.profiles (id),
  driver_name     text not null,
  fuel_card_id    uuid references public.fuel_cards (id),
  client_id       uuid references public.clients (id),
  purpose         text not null check (btrim(purpose) <> ''),
  status          text not null default 'open' check (status in ('open', 'ended', 'cancelled')),
  start_at        timestamptz not null default now(),
  start_odometer  numeric(10, 1) not null check (start_odometer >= 0),
  start_geo       jsonb,
  end_at          timestamptz,
  end_odometer    numeric(10, 1),
  end_geo         jsonb,
  km              numeric(10, 1) generated always as (case when end_odometer is null then null else end_odometer - start_odometer end) stored,
  added_at        timestamptz,
  added_by        uuid references public.profiles (id),
  added_note      text,
  created_at      timestamptz not null default now(),
  check (end_odometer is null or end_odometer >= start_odometer)
);
create unique index if not exists field_trips_one_open on public.field_trips (driver_id) where status = 'open';
comment on table public.field_trips is
  '0623: trips from the field app — odometer photo and reading at start and end, positions, km. No money (DECIDED 30 Oct 2026: the app''s own panel); the office prices a trip in the fuel sheet on the web and marks it added. Readable by the driver (own) and field.money_approve / expenses.edit.';
alter table public.field_trips enable row level security;
drop policy if exists field_trips_read on public.field_trips;
create policy field_trips_read on public.field_trips for select using (
  company_id = (select public.current_company_id())
  and (driver_id = (select auth.uid()) or (select public.has_perm('field.money_approve')) or (select public.has_perm('expenses.edit'))));
revoke all on public.field_trips from anon;
grant select on public.field_trips to authenticated;

create or replace function public.field_trip_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0623. The caller's open trip, its last 10, its fuel card, and the clients a trip may be for.
  declare v_card record;
  begin
    perform public.field_require('field.trips');
    select f.id, f.label, f.card_last4 into v_card
      from public.fuel_cards f join public.profiles p on p.id = auth.uid()
     where f.company_id = p.company_id and f.is_active and f.holder_employee_id = p.employee_id limit 1;
    return jsonb_build_object(
      'card', case when v_card.id is null then null else jsonb_build_object('label', v_card.label, 'last4', v_card.card_last4) end,
      'open', (select jsonb_build_object('id', t.id, 'start_at', t.start_at, 'start_odometer', t.start_odometer, 'purpose', t.purpose,
                                         'client', (select name from public.clients where id = t.client_id))
                 from public.field_trips t where t.driver_id = auth.uid() and t.status = 'open'),
      'recent', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'start_at', t.start_at, 'km', t.km, 'purpose', t.purpose,
                                         'client', (select name from public.clients where id = t.client_id), 'added', t.added_at is not null)
                                         order by t.start_at desc), '[]'::jsonb)
                   from (select * from public.field_trips where driver_id = auth.uid() and status = 'ended' order by start_at desc limit 10) t),
      'clients', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name), '[]'::jsonb)
                    from public.clients c
                   where c.company_id = public.current_company_id()
                     and exists (select 1 from public.contracts k where k.client_id = c.id and k.status = 'active')));
  end $$;
comment on function public.field_trip_state() is '0623: the field app''s trip screen — open trip, last 10, own fuel card, active clients. Kilometres only.';

create or replace function public.field_trip_start(p_odometer numeric, p_client_id uuid, p_purpose text, p_photo text, p_geo jsonb default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0623. Start a trip: odometer reading and photo, where to, what for.
  declare v_me record; v_card uuid; v_id uuid;
  begin
    perform public.field_require('field.trips');
    -- tenant guard [resolved]: the client's company, when given.
    if p_client_id is not null then perform public.assert_same_company((select c.company_id from public.clients c where c.id = p_client_id)); end if;
    if p_odometer is null or p_odometer < 0 then raise exception 'Enter the odometer reading.'; end if;
    if nullif(btrim(p_purpose), '') is null then raise exception 'Say what the trip is for.'; end if;
    if p_photo is null then raise exception 'Take a photo of the odometer.'; end if;
    if exists (select 1 from public.field_trips where driver_id = auth.uid() and status = 'open') then
      raise exception 'You already have a trip running. End it first.';
    end if;
    select p.id, p.employee_id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select f.id into v_card from public.fuel_cards f where f.company_id = public.current_company_id() and f.is_active and f.holder_employee_id = v_me.employee_id limit 1;
    insert into public.field_trips (company_id, driver_id, driver_name, fuel_card_id, client_id, purpose, start_odometer, start_geo)
    values (public.current_company_id(), v_me.id, v_me.name, v_card, p_client_id, btrim(p_purpose), round(p_odometer, 1), p_geo)
    returning id into v_id;
    perform public.field_store_photos(null, 'trip', 'field_trips', v_id, array[p_photo], p_geo);
    return v_id;
  end $$;
comment on function public.field_trip_start(numeric, uuid, text, text, jsonb) is '0623: start a field-app trip (field.trips) — one open at a time; odometer photo required.';

create or replace function public.field_trip_end(p_trip_id uuid, p_odometer numeric, p_photo text, p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0623. End the caller's open trip: odometer reading and photo; km = end − start.
  declare v_t record; v_client text;
  begin
    perform public.field_require('field.trips');
    -- tenant guard [resolved]: the trip's company; then it must be the caller's own.
    perform public.assert_same_company((select company_id from public.field_trips where id = p_trip_id));
    select * into v_t from public.field_trips where id = p_trip_id and driver_id = auth.uid() and status = 'open';
    if v_t.id is null then raise exception 'That trip is not running.'; end if;
    if p_odometer is null then raise exception 'Enter the odometer reading.'; end if;
    if p_odometer < v_t.start_odometer then
      raise exception 'The reading is below the start (%). Check it.', v_t.start_odometer;
    end if;
    if p_odometer - v_t.start_odometer > 2000 then raise exception 'That is over 2,000 km. Check the reading.'; end if;
    if p_photo is null then raise exception 'Take a photo of the odometer.'; end if;
    update public.field_trips set status = 'ended', end_at = now(), end_odometer = round(p_odometer, 1), end_geo = p_geo where id = p_trip_id;
    perform public.field_store_photos(null, 'trip', 'field_trips', p_trip_id, array[p_photo], p_geo);
    select name into v_client from public.clients where id = v_t.client_id;
    perform public.field_log('trip', 'field_trips', p_trip_id, null,
      'Trip ' || to_char(round(p_odometer, 1) - v_t.start_odometer, 'FM999,990.0') || ' km' || coalesce(' — ' || v_client, '') || ': ' || v_t.purpose, p_geo);
    return jsonb_build_object('km', round(p_odometer, 1) - v_t.start_odometer);
  end $$;
comment on function public.field_trip_end(uuid, numeric, text, jsonb) is '0623: end the caller''s open trip — reading not below the start, under 2,000 km, photo required; logs a line.';

create or replace function public.field_trip_cancel(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0623. Cancel the caller's open trip (started by mistake).
  declare n int;
  begin
    perform public.field_require('field.trips');
    -- tenant guard [resolved]: the trip's company; then it must be the caller's own.
    perform public.assert_same_company((select company_id from public.field_trips where id = p_trip_id));
    update public.field_trips set status = 'cancelled', end_at = now() where id = p_trip_id and driver_id = auth.uid() and status = 'open';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That trip is not running.'; end if;
  end $$;
comment on function public.field_trip_cancel(uuid) is '0623: cancel the caller''s own open trip.';

create or replace function public.mark_field_trip_added(p_trip_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0623. The office has put this trip on the fuel sheet (by hand, on the web).
  declare n int;
  begin
    if not (public.has_perm('field.money_approve') or public.has_perm('expenses.edit')) then
      raise exception 'Marking a trip added needs app-request approval or expenses permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the trip's company.
    perform public.assert_same_company((select company_id from public.field_trips where id = p_trip_id));
    update public.field_trips set added_at = now(), added_by = auth.uid(), added_note = nullif(btrim(p_note), '')
     where id = p_trip_id and status = 'ended' and added_at is null;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Only an ended trip not yet added can be marked added.'; end if;
    perform public.field_ack_ref('field_trips', p_trip_id, 'Added to the fuel sheet');
  end $$;
comment on function public.mark_field_trip_added(uuid, text) is '0623: marks an ended field-app trip as entered on the fuel sheet; acknowledges its line.';

revoke all on function public.field_trip_state() from public, anon;
grant execute on function public.field_trip_state() to authenticated;
revoke all on function public.field_trip_start(numeric, uuid, text, text, jsonb) from public, anon;
grant execute on function public.field_trip_start(numeric, uuid, text, text, jsonb) to authenticated;
revoke all on function public.field_trip_end(uuid, numeric, text, jsonb) from public, anon;
grant execute on function public.field_trip_end(uuid, numeric, text, jsonb) to authenticated;
revoke all on function public.field_trip_cancel(uuid) from public, anon;
grant execute on function public.field_trip_cancel(uuid) to authenticated;
revoke all on function public.mark_field_trip_added(uuid, text) from public, anon;
grant execute on function public.mark_field_trip_added(uuid, text) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_trip_state', null, 'EXEMPT 0623: field_require(field.trips) inside; own trips only'),
  ('field_trip_start', null, 'EXEMPT 0623: field_require(field.trips) inside'),
  ('field_trip_end', null, 'EXEMPT 0623: field_require(field.trips) inside; own trip only'),
  ('field_trip_cancel', null, 'EXEMPT 0623: field_require(field.trips) inside; own trip only'),
  ('mark_field_trip_added', '{field.money_approve,expenses.edit}', '0623: mark a field-app trip added to the fuel sheet')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  v_trip uuid; v_msg text; v_res jsonb; v_client uuid;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select client_id into v_client from public.sites where id = v_site;
    update public.profiles set user_type = 'office_staff', site_scope = '{}', permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_trip_state(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: record own trips (odometer at start and end)" permission for this. Ask a super admin.' then
      raise exception '0623 REFUSED: no field.trips got "%".', v_msg;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['field.app', 'field.trips'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    v_msg := null; begin perform public.field_trip_start(1000, v_client, 'Visit', null, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Take a photo of the odometer.' then raise exception '0623 REFUSED: a start with no photo got "%".', v_msg; end if;
    v_trip := public.field_trip_start(1000, v_client, 'Visit 68 HS', v_jpeg, '{"lat": 33.6, "lng": 73.0}');
    v_msg := null; begin perform public.field_trip_start(1001, null, 'Again', v_jpeg, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'You already have a trip running. End it first.' then raise exception '0623 REFUSED: a second start got "%".', v_msg; end if;
    if (public.field_trip_state() -> 'open' ->> 'id')::uuid is distinct from v_trip then raise exception '0623 REFUSED: the open trip is not in the state.'; end if;
    v_msg := null; begin perform public.field_trip_end(v_trip, 990, v_jpeg, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The reading is below the start (1000.0). Check it.' then raise exception '0623 REFUSED: ending below the start got "%".', v_msg; end if;
    v_res := public.field_trip_end(v_trip, 1034.5, v_jpeg, null);
    if (v_res ->> 'km')::numeric <> 34.5 or (select km from public.field_trips where id = v_trip) <> 34.5
       or (select count(*) from public.field_photos where ref_table = 'field_trips' and ref_id = v_trip and kind = 'trip') <> 2
       or not exists (select 1 from public.field_activity where ref_table = 'field_trips' and ref_id = v_trip and kind = 'trip')
       or (public.field_trip_state() -> 'open') <> 'null'::jsonb then
      raise exception '0623 REFUSED: ending the trip recorded %, or its photos, line or state are wrong.', v_res;
    end if;

    -- a supervisor is refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_trip_state(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This is done by the office, not in the site supervisor''s app.' then raise exception '0623 REFUSED: a supervisor got "%".', v_msg; end if;

    -- the office marks it added, once
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.mark_field_trip_added(v_trip, 'On the sheet');
    v_msg := null; begin perform public.mark_field_trip_added(v_trip, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only an ended trip not yet added can be marked added.' then raise exception '0623 REFUSED: marking twice got "%".', v_msg; end if;
    if not exists (select 1 from public.field_activity where ref_table = 'field_trips' and ref_id = v_trip and ack_at is not null) then
      raise exception '0623 REFUSED: marking added did not acknowledge the line.';
    end if;
    raise exception '0623-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0623-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0623 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0623 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0623 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
