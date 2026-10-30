-- 0618 — the office reviews what the site confirmed
--
-- DECIDED by Shayan, 30 Oct 2026: the office review REPLACES "the supervisor's
-- word is final" (0613). The plan of 28 Oct had it: the supervisor submits, the
-- office checks within 12 hours, returns or escalates, never auto-confirms. And:
-- "not just Nosherwan — anyone with permission; don't link anything with any
-- specific user". So the reviewer is whoever holds attendance.field_review (new,
-- in PERMISSION_GROUPS and permission_keys), and no name appears anywhere.
--
-- What a review is, and what it is not:
--   * The supervisor's confirmation still WRITES the attendance rows at once
--     (0613). Payroll reads attendance_records, and a shift that waited for an
--     office click before existing would leave the day blank whenever the office
--     was busy. The review is a second stage on the confirmation, not a gate in
--     front of the rows.
--   * ACCEPTED — the shift is the office's now. The phone can no longer change it
--     ("office wins", as for a shift the office confirmed itself).
--   * RETURNED — with a note saying what is wrong. The phone shows the note and
--     the supervisor may confirm again (same day only, as always); his new
--     confirmation is pending again. The office may of course correct the rows on
--     the Attendance Board instead, which makes the shift the office's.
--   * Not reviewed within 12 hours — an alert, once per shift (cron
--     'field-review-escalation', hourly). Never auto-accepted.
--   * When the office confirms the same shift on the board, the confirmation's
--     source stops being 'app' and the review no longer applies: a trigger clears
--     review_status, so the queue never shows a shift the office already owns.
--
-- The phone also sends its position with the confirmation (0614's field_geo);
-- it is stored on the confirmation and never refuses.
--
-- field_confirm_shift and field_shift_sheet have one author (0613), so they are
-- restated behind a digest precondition. field_confirm_shift gains p_geo, which
-- changes its signature: the 0613 one is dropped and the new one keeps the name,
-- its gate row and its grant.
--
--   review_field_attendance(confirmation, accept, note)   attendance.field_review
--   field_review_escalate()                               cron only
--
-- Asserted under a sentinel: a phone confirmation is pending; a return needs a
-- note; a returned shift may be confirmed again and is pending again; an accepted
-- one refuses the phone with its message and the sheet says so; a login without
-- the key cannot review; a board confirmation clears the review; a shift pending
-- 13 hours escalates exactly once.

-- -------------------------------------------------------------- columns
alter table public.attendance_confirmations add column if not exists review_status text check (review_status in ('pending', 'accepted', 'returned'));
alter table public.attendance_confirmations add column if not exists reviewed_by uuid references public.profiles (id);
alter table public.attendance_confirmations add column if not exists reviewed_by_name text;
alter table public.attendance_confirmations add column if not exists reviewed_at timestamptz;
alter table public.attendance_confirmations add column if not exists review_note text;
alter table public.attendance_confirmations add column if not exists escalated_at timestamptz;
alter table public.attendance_confirmations add column if not exists geo jsonb;
create index if not exists attendance_confirmations_review on public.attendance_confirmations (company_id, review_status) where review_status is not null;
comment on column public.attendance_confirmations.review_status is
  '0618: the office''s review of a site supervisor''s confirmation (source app). pending → accepted (the office''s now; the phone cannot change it) or returned (with review_note; the supervisor may confirm again the same day). Null for office confirmations. DECIDED 30 Oct 2026: reviewed by anyone with attendance.field_review, never a named person; escalated after 12 hours, never auto-accepted.';

insert into public.permission_keys (key, grp, label) values
  ('attendance.field_review', 'Attendance', 'Review site supervisors'' attendance from the field app — accept or return it')
on conflict (key) do nothing;

-- A board confirmation over a phone one makes the shift the office's: no review.
create or replace function public.attendance_confirmation_review_follows_source()
returns trigger
language plpgsql
set search_path = public
as $$
-- 0618. When the confirmation stops being the phone's, the review stops applying.
begin
  if new.source::text <> 'app' then
    new.review_status := null; new.review_note := null; new.escalated_at := null;
  end if;
  return new;
end $$;
comment on function public.attendance_confirmation_review_follows_source() is
  'TENANT GUARD EXEMPT: trigger on the row being written (0618) — an office confirmation clears the field review.';
drop trigger if exists trg_confirmation_review_follows_source on public.attendance_confirmations;
create trigger trg_confirmation_review_follows_source before insert or update on public.attendance_confirmations
  for each row execute function public.attendance_confirmation_review_follows_source();

-- -------------------------------------------------------------- restate (one author: 0613)
do $pre$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.field_shift_sheet(uuid, text)'::regprocedure) <> '33e9ae46be3f327b8edd4d93dbc10f42' then
    raise exception '0618 REFUSED: field_shift_sheet is not the 0613 body this file replaces.';
  end if;
  if to_regprocedure('public.field_confirm_shift(uuid, text, jsonb, jsonb)') is not null
     and (select md5(prosrc) from pg_proc where oid = 'public.field_confirm_shift(uuid, text, jsonb, jsonb)'::regprocedure) <> 'ff7242505ff435cc6464ae4063b21333' then
    raise exception '0618 REFUSED: field_confirm_shift is not the 0613 body this file replaces.';
  end if;
end $pre$;

create or replace function public.field_shift_sheet(p_site_id uuid, p_shift text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0613/0618. One site-shift today: guards with today's mark, the relievers sent there, the confirmation and its review.
  declare
    v_date date := public.field_today();
    v_site record; v_conf record; v_office boolean; v_sup boolean := public.is_site_supervisor();
    v_guards jsonb; v_rel jsonb; v_shifts jsonb; v_why text;
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site checks the caller may see it.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_shift is null or p_shift not in ('day', 'evening', 'night') then raise exception 'Choose the day, evening or night shift.'; end if;
    select s.id, s.name, s.client_id, c.name as client into v_site from public.sites s left join public.clients c on c.id = s.client_id where s.id = p_site_id;

    select coalesce(jsonb_agg(jsonb_build_object('shift', x.shift, 'guards', x.n) order by array_position(array['day','evening','night'], x.shift)), '[]'::jsonb)
      into v_shifts from (select r.shift, count(*) n from public.field_site_roster(p_site_id) r group by r.shift) x;

    select coalesce(jsonb_agg(jsonb_build_object(
             'employee_id', r.employee_id, 'full_name', r.full_name, 'employee_code', r.employee_code,
             'has_photo', r.has_photo, 'flags', to_jsonb(r.flags),
             'status', m.status, 'other_shift', m.other_shift) order by r.full_name), '[]'::jsonb)
      into v_guards
      from public.field_site_roster(p_site_id) r
      left join lateral (
        select case when bool_or(a.status = 'double_duty') then 'double_duty'
                    when bool_or(public.attendance_status_is_leave(a.status)) then 'leave'
                    else max(a.status) filter (where a.worked_shift = p_shift) end as status,
               max(a.worked_shift) filter (where a.status = 'double_duty' and a.worked_shift <> p_shift) as other_shift
          from public.attendance_records a where a.employee_id = r.employee_id and a.attendance_date = v_date) m on true
     where r.shift = p_shift;

    select coalesce(jsonb_agg(jsonb_build_object(
             'record_id', a.id, 'employee_id', e.id, 'full_name', e.full_name, 'employee_code', e.employee_code,
             'covering_for', cf.full_name, 'arrived', ra.arrived) order by e.full_name), '[]'::jsonb)
      into v_rel
      from public.attendance_records a
      join public.employees e on e.id = a.employee_id and e.category::text = 'reliever'
      left join public.employees cf on cf.id = a.covering_for_guard_id
      left join public.reliever_arrivals ra on ra.attendance_record_id = a.id
     where a.site_id = p_site_id and a.attendance_date = v_date and a.worked_shift = p_shift and a.status = 'present';

    select c.supervisor_name, c.source::text as source, c.confirmed_at, c.confirmed_by,
           c.review_status, c.review_note, c.reviewed_by_name into v_conf
      from public.attendance_confirmations c
     where c.company_id = public.current_company_id() and c.group_key = p_site_id::text and c.shift_code = p_shift and c.attendance_date = v_date;
    v_office := v_conf.confirmed_at is not null and not exists (
      select 1 from public.profiles p where p.id = v_conf.confirmed_by and p.user_type = 'site_supervisor');

    v_why := case when not v_sup then 'The office confirms attendance on the Attendance Board; the field app shows it.'
                  when v_office then 'Already confirmed by the office (' || v_conf.supervisor_name || '). Ask the office to change it.'
                  when v_conf.review_status = 'accepted' then 'Accepted by the office (' || coalesce(v_conf.reviewed_by_name, 'office') || '). Ask the office to change it.'
                  when jsonb_array_length(v_guards) = 0 and jsonb_array_length(v_rel) = 0 then 'Nobody is posted on this shift.'
             end;

    return jsonb_build_object(
      'date', v_date, 'shift', p_shift,
      'site', jsonb_build_object('id', v_site.id, 'name', v_site.name, 'client', v_site.client),
      'shifts', v_shifts, 'guards', v_guards, 'relievers', v_rel,
      'confirmation', case when v_conf.confirmed_at is null then null else jsonb_build_object(
        'supervisor_name', v_conf.supervisor_name, 'source', v_conf.source, 'confirmed_at', v_conf.confirmed_at, 'by_office', v_office,
        'review_status', v_conf.review_status, 'review_note', v_conf.review_note, 'reviewed_by_name', v_conf.reviewed_by_name) end,
      'can_confirm', v_why is null, 'why_not', v_why);
  end $$;
comment on function public.field_shift_sheet(uuid, text) is
  '0613/0618: one site-shift today (Pakistan) for the field app — guards and today''s marks, relievers sent, the confirmation with the office''s review, and whether the caller may confirm. field_can_see_site decides the site. No pay, no CNIC numbers.';

drop function if exists public.field_confirm_shift(uuid, text, jsonb, jsonb);
create or replace function public.field_confirm_shift(p_site_id uuid, p_shift text, p_marks jsonb default '[]'::jsonb, p_relievers jsonb default '[]'::jsonb, p_geo jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0613/0618. A site supervisor confirms one site-shift today; the office then reviews it.
  declare
    v_date date := public.field_today();
    v_me record; v_site record; v_conf record;
    g record; m jsonb; v_rl jsonb; v_status text; v_other text; v_shifts text[]; v_ws text;
    v_counts jsonb := jsonb_build_object('present', 0, 'absent', 0, 'leave', 0, 'double_duty', 0, 'relievers_arrived', 0, 'relievers_missing', 0);
    v_bad uuid; v_rec record; n int; v_roster uuid[];
  begin
    if not public.is_site_supervisor() then
      raise exception 'The office confirms attendance on the Attendance Board; only a site supervisor confirms in the field app.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the site's company; then field_can_see_site checks it is on the supervisor's list.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_shift is null or p_shift not in ('day', 'evening', 'night') then raise exception 'Choose the day, evening or night shift.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.id, s.name, s.client_id into v_site from public.sites s where s.id = p_site_id;

    -- Office wins (DECIDED 30 Oct 2026): a shift the office confirmed, or accepted on review, is not the phone's to change.
    select c.supervisor_name, c.confirmed_by, c.review_status, c.reviewed_by_name into v_conf
      from public.attendance_confirmations c
     where c.company_id = public.current_company_id() and c.group_key = p_site_id::text and c.shift_code = p_shift and c.attendance_date = v_date;
    if found and not exists (select 1 from public.profiles p where p.id = v_conf.confirmed_by and p.user_type = 'site_supervisor') then
      raise exception 'Already confirmed by the office (%). Ask the office to change it.', v_conf.supervisor_name using errcode = '42501';
    end if;
    if found and v_conf.review_status = 'accepted' then
      raise exception 'Accepted by the office (%). Ask the office to change it.', coalesce(v_conf.reviewed_by_name, 'office') using errcode = '42501';
    end if;

    -- Every mark names a guard on THIS shift of this site, with a known status.
    select coalesce(array_agg(r.employee_id), '{}') into v_roster from public.field_site_roster(p_site_id) r where r.shift = p_shift;
    select (x ->> 'employee_id')::uuid into v_bad from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) x
     where not ((x ->> 'employee_id')::uuid = any (v_roster)) limit 1;
    if v_bad is not null then raise exception 'That guard is not on this shift.' using errcode = '42501'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) x
                where coalesce(x ->> 'status', '') not in ('present', 'absent', 'leave', 'double_duty')
                   or (x ->> 'status' = 'double_duty' and (coalesce(x ->> 'other_shift', '') not in ('day', 'evening', 'night') or x ->> 'other_shift' = p_shift))) then
      raise exception 'Mark each guard present, absent, leave, or double duty with the second shift.';
    end if;

    for g in select u as employee_id from unnest(v_roster) u loop
      select x into m from jsonb_array_elements(coalesce(p_marks, '[]'::jsonb)) x where (x ->> 'employee_id')::uuid = g.employee_id limit 1;
      v_status := coalesce(m ->> 'status', 'present');
      v_other := case when v_status = 'double_duty' then m ->> 'other_shift' end;
      v_shifts := case when v_status = 'double_duty' then array[p_shift, v_other] else array[p_shift] end;

      -- Clear what would contradict the write (mirrors clearConflictingDayRows).
      if v_status in ('leave', 'double_duty') then
        delete from public.attendance_records where employee_id = g.employee_id and attendance_date = v_date;
      else
        delete from public.attendance_records
         where employee_id = g.employee_id and attendance_date = v_date
           and (public.attendance_status_is_leave(status) or status = 'double_duty' or (status = 'present' and worked_shift is distinct from p_shift));
      end if;

      foreach v_ws in array v_shifts loop
        insert into public.attendance_records
          (employee_id, attendance_date, status, scheduled_shift, worked_shift, entry_type, source, marked_at,
           supervisor_override, override_reason, absent_reason)
        values (g.employee_id, v_date, v_status, p_shift, v_ws,
                case when v_status = 'double_duty' then 'double_duty' else 'normal' end::public.attendance_entry_type,
                'app', now(), false, null, null)
        on conflict (employee_id, attendance_date, worked_shift) do update
          set status = excluded.status, scheduled_shift = excluded.scheduled_shift, entry_type = excluded.entry_type,
              source = excluded.source, marked_at = excluded.marked_at, supervisor_override = false,
              override_reason = null, absent_reason = null;
      end loop;
      v_counts := jsonb_set(v_counts, array[v_status], to_jsonb((v_counts ->> v_status)::int + 1));
    end loop;

    -- Relievers the office sent here today on this shift: arrived or not.
    for v_rl in select x from jsonb_array_elements(coalesce(p_relievers, '[]'::jsonb)) x loop
      select a.id, e.full_name into v_rec
        from public.attendance_records a join public.employees e on e.id = a.employee_id and e.category::text = 'reliever'
       where a.id = (v_rl ->> 'record_id')::uuid and a.site_id = p_site_id and a.attendance_date = v_date
         and a.worked_shift = p_shift and a.status = 'present';
      if v_rec.id is null then raise exception 'That reliever was not sent to this shift today.' using errcode = '42501'; end if;
      insert into public.reliever_arrivals (attendance_record_id, company_id, arrived, confirmed_by, supervisor_name, confirmed_at)
      values (v_rec.id, public.current_company_id(), coalesce((v_rl ->> 'arrived')::boolean, true), v_me.id, v_me.name, now())
      on conflict (attendance_record_id) do update
        set arrived = excluded.arrived, confirmed_by = excluded.confirmed_by, supervisor_name = excluded.supervisor_name, confirmed_at = excluded.confirmed_at;
      if coalesce((v_rl ->> 'arrived')::boolean, true) then
        v_counts := jsonb_set(v_counts, '{relievers_arrived}', to_jsonb((v_counts ->> 'relievers_arrived')::int + 1));
      else
        v_counts := jsonb_set(v_counts, '{relievers_missing}', to_jsonb((v_counts ->> 'relievers_missing')::int + 1));
        perform public.raise_alert(public.current_company_id(), 'warning', 'attendance',
          v_site.name || ' (' || p_shift || ' shift): ' || v_me.name || ' says reliever ' || v_rec.full_name
            || ' did not arrive. He is still marked present there — check the Relief pool.',
          'reliever_arrivals', v_rec.id, null);
      end if;
    end loop;

    -- The confirmation, pending the office's review (0618); a returned one is pending again.
    insert into public.attendance_confirmations
      (company_id, group_key, client_id, site_id, shift_code, attendance_date, supervisor_name, source, confirmed_by, confirmed_at,
       review_status, reviewed_by, reviewed_by_name, reviewed_at, review_note, escalated_at, geo)
    values (public.current_company_id(), p_site_id::text, v_site.client_id, p_site_id, p_shift, v_date, v_me.name, 'app', v_me.id, now(),
            'pending', null, null, null, null, null, public.field_geo(p_site_id, p_geo))
    on conflict (company_id, group_key, shift_code, attendance_date) do update
      set supervisor_name = excluded.supervisor_name, source = excluded.source, confirmed_by = excluded.confirmed_by,
          confirmed_at = excluded.confirmed_at, client_id = excluded.client_id, site_id = excluded.site_id,
          review_status = 'pending', reviewed_by = null, reviewed_by_name = null, reviewed_at = null, review_note = null,
          escalated_at = null, geo = excluded.geo;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'The confirmation was not recorded.'; end if;
    update public.alerts set state = 'resolved', acknowledged_by = auth.uid(), acknowledged_at = now()
     where ref_table = 'attendance_confirmations' and state = 'open'
       and ref_id = (select c.id from public.attendance_confirmations c where c.company_id = public.current_company_id()
                      and c.group_key = p_site_id::text and c.shift_code = p_shift and c.attendance_date = v_date);

    return v_counts || jsonb_build_object('date', v_date, 'shift', p_shift, 'confirmed_by', v_me.name, 'review_status', 'pending');
  end $$;
comment on function public.field_confirm_shift(uuid, text, jsonb, jsonb, jsonb) is
  '0613/0618: a site supervisor confirms one site-shift TODAY (Pakistan): unmarked guards present, the rest as marked; relievers arrived or not; confirmation source app, pending the office''s review. Refused once the office has confirmed or accepted the shift (office wins). Position recorded, never refused. The attendance triggers apply as for the board; supervisor_override stays false.';
revoke all on function public.field_confirm_shift(uuid, text, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.field_confirm_shift(uuid, text, jsonb, jsonb, jsonb) to authenticated;

-- -------------------------------------------------------------- the review
create or replace function public.review_field_attendance(p_confirmation_id uuid, p_accept boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0618. Accept a site's confirmation, or return it with a note.
  declare v_name text; n int;
  begin
    if not public.has_perm('attendance.field_review') then
      raise exception 'Reviewing site attendance needs the "Review site attendance" permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the confirmation's company.
    perform public.assert_same_company((select company_id from public.attendance_confirmations where id = p_confirmation_id));
    if not p_accept and nullif(btrim(p_note), '') is null then raise exception 'Say what is wrong, so the site can fix it.'; end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    update public.attendance_confirmations
       set review_status = case when p_accept then 'accepted' else 'returned' end,
           reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now(), review_note = nullif(btrim(p_note), '')
     where id = p_confirmation_id and source = 'app' and review_status in ('pending', 'returned');
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That shift is not waiting for review.'; end if;
    update public.alerts set state = 'resolved', acknowledged_by = auth.uid(), acknowledged_at = now()
     where ref_table = 'attendance_confirmations' and ref_id = p_confirmation_id and state = 'open';
  end $$;
comment on function public.review_field_attendance(uuid, boolean, text) is
  '0618: attendance.field_review accepts a site supervisor''s confirmation (the office''s from then on) or returns it with a note (the supervisor may confirm again the same day).';
revoke all on function public.review_field_attendance(uuid, boolean, text) from public, anon;
grant execute on function public.review_field_attendance(uuid, boolean, text) to authenticated;

create or replace function public.field_review_escalate()
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0618. Hourly: a site confirmation not reviewed in 12 hours alerts once. Never auto-accepts.
  -- tenant guard [exempt]: cron only, revoked from every API role; each alert goes to the row's own company.
  declare c record; n int := 0;
  begin
    for c in select ac.id, ac.company_id, ac.shift_code, ac.attendance_date, ac.supervisor_name, s.name as site
               from public.attendance_confirmations ac left join public.sites s on s.id = ac.site_id
              where ac.review_status = 'pending' and ac.escalated_at is null and ac.confirmed_at < now() - interval '12 hours' loop
      perform public.raise_alert(c.company_id, 'warning', 'attendance',
        coalesce(c.site, 'A site') || ' (' || c.shift_code || ' shift, ' || to_char(c.attendance_date, 'DD Mon') || '): '
          || c.supervisor_name || '''s attendance has not been reviewed in 12 hours. Review it on the Attendance Board.',
        'attendance_confirmations', c.id, null);
      update public.attendance_confirmations set escalated_at = now() where id = c.id;
      n := n + 1;
    end loop;
    return n;
  end $$;
comment on function public.field_review_escalate() is
  'TENANT GUARD EXEMPT: cron only (0618) — alerts once for each site confirmation not reviewed in 12 hours.';
revoke all on function public.field_review_escalate() from public, anon, authenticated;
do $cron$ begin
  if not exists (select 1 from cron.job where jobname = 'field-review-escalation') then
    perform cron.schedule('field-review-escalation', '15 * * * *', 'select public.field_review_escalate()');
  end if;
end $cron$;

insert into public.api_function_gates (function_name, any_of, reason) values
  ('review_field_attendance', '{attendance.field_review}', '0618: accept / return a site''s attendance')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_shift text; v_ids uuid[]; v_conf uuid; v_msg text; v_sheet jsonb; v_at timestamptz;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.shift into v_shift from public.field_site_roster(v_site) r group by r.shift order by count(*) desc limit 1;
    select array_agg(r.employee_id) into v_ids from public.field_site_roster(v_site) r where r.shift = v_shift;
    delete from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today;
    delete from public.attendance_records where attendance_date = v_today and employee_id = any (v_ids);

    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb, '{"lat": 33.6, "lng": 73.0}');
    select id into v_conf from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today
       and review_status = 'pending' and geo is not null;
    if v_conf is null then raise exception '0618 REFUSED: a phone confirmation is not pending with its position.'; end if;
    v_msg := null; begin perform public.review_field_attendance(v_conf, true, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Reviewing site attendance needs the "Review site attendance" permission.' then raise exception '0618 REFUSED: a supervisor reviewing got "%".', v_msg; end if;

    -- return needs a note; a returned shift may be confirmed again, pending again
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.review_field_attendance(v_conf, false, ' '); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Say what is wrong, so the site can fix it.' then raise exception '0618 REFUSED: a return with no note got "%".', v_msg; end if;
    perform public.review_field_attendance(v_conf, false, 'Check the night guard');
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_sheet := public.field_shift_sheet(v_site, v_shift);
    if v_sheet -> 'confirmation' ->> 'review_status' <> 'returned' or v_sheet -> 'confirmation' ->> 'review_note' <> 'Check the night guard'
       or not (v_sheet ->> 'can_confirm')::boolean then
      raise exception '0618 REFUSED: the sheet does not show the return or does not offer a new confirmation: %.', v_sheet -> 'confirmation';
    end if;
    perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb, null);
    if (select review_status from public.attendance_confirmations where id = v_conf) <> 'pending' then raise exception '0618 REFUSED: confirming again did not make it pending.'; end if;

    -- accepted: the phone is refused, the sheet says so
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.review_field_attendance(v_conf, true, null);
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Accepted by the office (' || (select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = v_boss) || '). Ask the office to change it.' then
      raise exception '0618 REFUSED: an accepted shift let the phone through: "%".', v_msg;
    end if;
    if (public.field_shift_sheet(v_site, v_shift) ->> 'can_confirm')::boolean then raise exception '0618 REFUSED: the sheet offers an accepted shift.'; end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.review_field_attendance(v_conf, true, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That shift is not waiting for review.' then raise exception '0618 REFUSED: reviewing twice got "%".', v_msg; end if;

    -- 13 hours pending escalates once; a board confirmation clears the review
    update public.attendance_confirmations set review_status = 'pending', confirmed_at = now() - interval '13 hours', escalated_at = null where id = v_conf;
    perform public.field_review_escalate();
    select escalated_at into v_at from public.attendance_confirmations where id = v_conf;
    if v_at is null or not exists (select 1 from public.alerts where ref_table = 'attendance_confirmations' and ref_id = v_conf and state = 'open') then
      raise exception '0618 REFUSED: a shift pending 13 hours did not escalate.';
    end if;
    perform public.field_review_escalate();
    if (select escalated_at from public.attendance_confirmations where id = v_conf) is distinct from v_at then
      raise exception '0618 REFUSED: it escalated twice.';
    end if;
    update public.attendance_confirmations set source = 'manual', confirmed_by = v_boss where id = v_conf;
    if (select review_status from public.attendance_confirmations where id = v_conf) is not null then raise exception '0618 REFUSED: a board confirmation kept the review.'; end if;
    raise exception '0618-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0618-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0618 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0618 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0618 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
