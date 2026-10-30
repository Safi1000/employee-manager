-- 0613 — site attendance on the field app
--
-- Shayan, 30 Oct 2026: attendance is "per shift; relievers are sent from the
-- office; confirmation will be given from the site supervisor". Then, asked:
-- reliever STAFF only are sent (category reliever); if the office has already
-- marked a shift, THE OFFICE WINS; a supervisor confirms the SAME DAY only.
--
-- The phone writes what the Attendance Board writes — the same attendance_records
-- rows and the same attendance_confirmations row per site-shift-day — so every
-- rule on those tables (half/month locks, backfill window, leave-is-the-whole-
-- day, double-duty-is-exactly-two, one status per day) binds the phone exactly
-- as it binds the board. Nothing here relaxes one: supervisor_override stays
-- false, so a locked day refuses the phone where it would not refuse an office
-- override.
--
--   field_today()          the date in Pakistan (Asia/Karachi). The database
--                          runs in UTC, five hours behind: from midnight to 5 am
--                          its current_date is still yesterday, and "same day
--                          only" has to mean the supervisor's day.
--   field_site_roster      surgery (0607, 0612): guards are now placed by their
--                          DEPLOYMENT covering today, as the Attendance Board and
--                          attendance_records (deployment_site_on) place them —
--                          not by contract line. On 30 Oct the two agreed on 370
--                          of 375 guards; the five that differed (Salman Sahil
--                          GGS-00643 deployed at 68 HS, listed at PCI; three Bank
--                          of AJK guards across Rawalakot / Ladies / PDA Housing;
--                          M. Riaz Akhtar EMP-0090 with no deployment) now follow
--                          their deployment, so the phone, the board and the
--                          record agree on who stands where. The shift follows
--                          the board too: the deployment's, else the line's, else
--                          the guard's. Pool relievers leave the roster (the
--                          board keeps them on the Relievers tab).
--   field_shift_sheet      one site-shift today: its guards with today's mark,
--                          the pool relievers the office sent there, who has
--                          confirmed it, and whether this caller may.
--   field_confirm_shift    a SITE SUPERVISOR confirms the shift: unmarked guards
--                          present, the rest as marked (absent / leave / double
--                          duty with its second shift), the relievers arrived or
--                          not, and the confirmation stamped source 'app' with
--                          the supervisor's own name. Refused when the office
--                          has confirmed that shift (office wins), for any day
--                          but today, for a guard not on that shift, and for an
--                          office login (the office uses the board).
--   reliever_arrivals      the supervisor's word on each reliever the office
--                          sent. The office's Send already writes the reliever's
--                          attendance at the site (Relief pool) — that row IS the
--                          dispatch. "Didn't arrive" does not delete it (office
--                          wins); it raises an alert, shows on the Relief pool,
--                          and the office decides.
--
-- Clearing before writing mirrors clearConflictingDayRows (lib/attendanceDay.ts),
-- which every board write runs first: a leave or a double duty owns the whole
-- day; a single worked mark removes the day's leave, a present on another shift
-- and a stale double duty — so re-confirming a double duty as present does not
-- leave the second leg behind for trg_double_duty_is_exactly_two to refuse.
--
-- No financial data: the field_* review list from 0612 is extended by these
-- three and re-asserted, and field_shift_sheet's keys are checked against a
-- fixed list.
--
-- Asserted (rolled back by a sentinel whose message is checked) with the HR
-- login made the supervisor of 68 HS: every guard on every roster is where
-- deployment_site_on puts him; the sheet offers the shift; a confirmation writes
-- absent / leave / double duty (two rows) / present, source 'app', and a
-- confirmation in the supervisor's name; a reliever marked not arrived is
-- recorded and alerts; re-confirming all present leaves exactly one row per
-- guard; an office confirmation then refuses the phone; an office login, another
-- site and a guard from another shift are refused with their messages.

-- -------------------------------------------------------------- today, in Pakistan
create or replace function public.field_today()
returns date
language sql
stable
set search_path = public
as $$
  -- 0613. The field app's "today": the date in Pakistan, not the database's UTC date.
  select (now() at time zone 'Asia/Karachi')::date;
$$;
revoke all on function public.field_today() from public, anon;
grant execute on function public.field_today() to authenticated;

-- -------------------------------------------------------------- roster: by deployment
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_site_roster(uuid)'::regprocedure);
  a1_old constant text := $a$    select e.id, e.full_name, e.employee_code, coalesce(e.shift, l.shift_code::text), e.phone,$a$;
  a1_new constant text := $a$    select e.id, e.full_name, e.employee_code, coalesce(d.shift_code, l.shift_code::text, e.shift, 'day'), e.phone,$a$;
  a2_old constant text := $a$      from public.employees e left join public.contract_lines l on l.id = e.contract_line_id
     where (l.site_id = p_site_id or (l.site_id is null and v_whole_client and e.client_id = v_client))$a$;
  a2_new constant text := $a$      -- 0613: placed by DEPLOYMENT — the guard's deployment covering today (Pakistan),
      -- as the Attendance Board and attendance_records (deployment_site_on) place him.
      from public.employees e
      join lateral (select dd.site_id, dd.client_id, dd.shift_code, dd.contract_line_id from public.deployments dd
                     where dd.guard_id = e.id and dd.start_date <= public.field_today()
                       and (dd.end_date is null or dd.end_date >= public.field_today())
                     order by dd.start_date desc, dd.created_at desc limit 1) d on true
      left join public.contract_lines l on l.id = coalesce(d.contract_line_id, e.contract_line_id)
     where (d.site_id = p_site_id or (d.site_id is null and v_whole_client and d.client_id = v_client))
       and e.category::text is distinct from 'reliever'$a$;
  a3_old constant text := $a$     order by coalesce(e.shift, l.shift_code::text), e.full_name;$a$;
  a3_new constant text := $a$     order by 4, e.full_name;$a$;
  v_n int;
begin
  if position('-- 0613: placed by DEPLOYMENT' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a1_old, ''))) / length(a1_old);
  if v_n <> 1 then raise exception '0613 REFUSED: roster anchor 1 appears % times, not once.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a2_old, ''))) / length(a2_old);
  if v_n <> 1 then raise exception '0613 REFUSED: roster anchor 2 appears % times, not once.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a3_old, ''))) / length(a3_old);
  if v_n <> 1 then raise exception '0613 REFUSED: roster anchor 3 appears % times, not once.', v_n; end if;
  execute replace(replace(replace(v_def, a1_old, a1_new), a2_old, a2_new), a3_old, a3_new);
end $surgery$;
comment on function public.field_site_roster(uuid) is
  '0607/0612/0613: guards posted at a site by their deployment covering today — name, code, shift, phone, has-photo, expiry flags. Only for a caller field_can_see_site allows. Never CNIC numbers or pay.';

-- -------------------------------------------------------------- the supervisor's word on a reliever
create table if not exists public.reliever_arrivals (
  attendance_record_id uuid primary key references public.attendance_records (id) on delete cascade,
  company_id      uuid not null references public.companies (id),
  arrived         boolean not null,
  confirmed_by    uuid not null references public.profiles (id),
  supervisor_name text not null,
  confirmed_at    timestamptz not null default now()
);
comment on table public.reliever_arrivals is
  '0613: a site supervisor''s word on a pool reliever the office sent — arrived or not. One per reliever attendance row (the office''s Send writes that row; it is the dispatch). Written only by field_confirm_shift. "Not arrived" never deletes the office''s row (office wins, DECIDED 30 Oct 2026): it alerts, and the office decides on the Relief pool.';
alter table public.reliever_arrivals enable row level security;
drop policy if exists reliever_arrivals_read on public.reliever_arrivals;
create policy reliever_arrivals_read on public.reliever_arrivals for select using (
  company_id = (select public.current_company_id())
  and ((select public.has_perm('attendance.view')) or (select public.has_perm('attendance.edit'))));
revoke all on public.reliever_arrivals from anon;
grant select on public.reliever_arrivals to authenticated;

-- -------------------------------------------------------------- one site-shift, today
create or replace function public.field_shift_sheet(p_site_id uuid, p_shift text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0613. One site-shift today: guards with today's mark, the relievers sent there, the confirmation.
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

    select c.supervisor_name, c.source::text as source, c.confirmed_at, c.confirmed_by into v_conf
      from public.attendance_confirmations c
     where c.company_id = public.current_company_id() and c.group_key = p_site_id::text and c.shift_code = p_shift and c.attendance_date = v_date;
    v_office := v_conf.confirmed_at is not null and not exists (
      select 1 from public.profiles p where p.id = v_conf.confirmed_by and p.user_type = 'site_supervisor');

    v_why := case when not v_sup then 'The office confirms attendance on the Attendance Board; the field app shows it.'
                  when v_office then 'Already confirmed by the office (' || v_conf.supervisor_name || '). Ask the office to change it.'
                  when jsonb_array_length(v_guards) = 0 and jsonb_array_length(v_rel) = 0 then 'Nobody is posted on this shift.'
             end;

    return jsonb_build_object(
      'date', v_date, 'shift', p_shift,
      'site', jsonb_build_object('id', v_site.id, 'name', v_site.name, 'client', v_site.client),
      'shifts', v_shifts, 'guards', v_guards, 'relievers', v_rel,
      'confirmation', case when v_conf.confirmed_at is null then null else jsonb_build_object(
        'supervisor_name', v_conf.supervisor_name, 'source', v_conf.source, 'confirmed_at', v_conf.confirmed_at, 'by_office', v_office) end,
      'can_confirm', v_why is null, 'why_not', v_why);
  end $$;
comment on function public.field_shift_sheet(uuid, text) is
  '0613: one site-shift today (Pakistan) for the field app — guards and today''s marks, relievers sent, the confirmation, and whether the caller may confirm. field_can_see_site decides the site. No pay, no CNIC numbers.';

-- -------------------------------------------------------------- the supervisor confirms
create or replace function public.field_confirm_shift(p_site_id uuid, p_shift text, p_marks jsonb default '[]'::jsonb, p_relievers jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0613. A site supervisor confirms one site-shift today: guards, relievers, and the confirmation.
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

    -- Office wins (DECIDED 30 Oct 2026): a shift the office confirmed is not the phone's to change.
    select c.supervisor_name, c.confirmed_by into v_conf
      from public.attendance_confirmations c
     where c.company_id = public.current_company_id() and c.group_key = p_site_id::text and c.shift_code = p_shift and c.attendance_date = v_date;
    if found and not exists (select 1 from public.profiles p where p.id = v_conf.confirmed_by and p.user_type = 'site_supervisor') then
      raise exception 'Already confirmed by the office (%). Ask the office to change it.', v_conf.supervisor_name using errcode = '42501';
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

    insert into public.attendance_confirmations
      (company_id, group_key, client_id, site_id, shift_code, attendance_date, supervisor_name, source, confirmed_by, confirmed_at)
    values (public.current_company_id(), p_site_id::text, v_site.client_id, p_site_id, p_shift, v_date, v_me.name, 'app', v_me.id, now())
    on conflict (company_id, group_key, shift_code, attendance_date) do update
      set supervisor_name = excluded.supervisor_name, source = excluded.source, confirmed_by = excluded.confirmed_by,
          confirmed_at = excluded.confirmed_at, client_id = excluded.client_id, site_id = excluded.site_id;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'The confirmation was not recorded.'; end if;

    return v_counts || jsonb_build_object('date', v_date, 'shift', p_shift, 'confirmed_by', v_me.name);
  end $$;
comment on function public.field_confirm_shift(uuid, text, jsonb, jsonb) is
  '0613: a site supervisor confirms one site-shift TODAY (Pakistan): unmarked guards present, the rest as marked; relievers arrived or not; confirmation source app in the supervisor''s name. Refused once the office has confirmed the shift (office wins). The attendance triggers apply as for the board; supervisor_override stays false.';

revoke all on function public.field_shift_sheet(uuid, text) from public, anon;
grant execute on function public.field_shift_sheet(uuid, text) to authenticated;
revoke all on function public.field_confirm_shift(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.field_confirm_shift(uuid, text, jsonb, jsonb) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_today', null, 'EXEMPT 0613: the date in Pakistan'),
  ('field_shift_sheet', null, 'EXEMPT 0613: field_can_see_site checked inside'),
  ('field_confirm_shift', null, 'EXEMPT 0613: site supervisors only, field_can_see_site checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_known constant text[] := array['field_can_see_site', 'field_confirm_shift', 'field_guard_photo', 'field_me', 'field_office_user',
                                   'field_register_device', 'field_request_device', 'field_shift_sheet', 'field_site_roster', 'field_today'];
  v_cols  constant text[] := array['employee_id', 'full_name', 'employee_code', 'shift', 'phone', 'has_photo', 'flags'];
  v_sheet_keys constant text[] := array['date', 'shift', 'site', 'shifts', 'guards', 'relievers', 'confirmation', 'can_confirm', 'why_not'];
  v_guard_keys constant text[] := array['employee_id', 'full_name', 'employee_code', 'has_photo', 'flags', 'status', 'other_shift'];
  v_rel_keys   constant text[] := array['record_id', 'employee_id', 'full_name', 'employee_code', 'covering_for', 'arrived'];
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_shift text; v_other_shift text; v_ids uuid[]; v_sheet jsonb; v_res jsonb; v_msg text; v_bad text; v_n int;
  v_rel uuid; v_rel_rec uuid; v_other_site uuid; v_stranger uuid;
begin
  -- No financial data: every field_* function reviewed; returned columns listed.
  select string_agg(proname, ', ') into v_bad from pg_proc
   where pronamespace = 'public'::regnamespace and proname ~ '^field_' and not (proname = any (v_known));
  if v_bad is not null then raise exception '0613 REFUSED: field_* function(s) % not reviewed for money columns — check and add to the list.', v_bad; end if;
  select string_agg(p.proname || '.' || a.n, ', ') into v_bad
    from pg_proc p cross join lateral unnest(p.proargnames, p.proargmodes) as a(n, m)
   where p.pronamespace = 'public'::regnamespace and p.proname ~ '^field_' and a.m in ('t', 'o') and not (a.n = any (v_cols));
  if v_bad is not null then raise exception '0613 REFUSED: field_* returns unlisted column(s) %.', v_bad; end if;
  if public.field_today() <> v_today then raise exception '0613 REFUSED: field_today is % and Pakistan is on %.', public.field_today(), v_today; end if;

  begin
    -- every roster guard stands where his deployment puts him
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select count(*) into v_n from public.sites s cross join lateral public.field_site_roster(s.id) r
     where s.company_id = v_co and public.deployment_site_on(r.employee_id, v_today) is distinct from s.id
       and not (public.deployment_site_on(r.employee_id, v_today) is null and public.deployment_client_on(r.employee_id, v_today) = s.client_id);
    if v_n <> 0 then raise exception '0613 REFUSED: % roster guards stand somewhere their deployment does not put them.', v_n; end if;

    select r.shift into v_shift from public.field_site_roster(v_site) r group by r.shift order by count(*) desc limit 1;
    select array_agg(r.employee_id order by r.full_name) into v_ids from public.field_site_roster(v_site) r where r.shift = v_shift;
    if coalesce(cardinality(v_ids), 0) < 3 then raise exception '0613 REFUSED: 68 HS has % guards on its largest shift; the test needs 3.', coalesce(cardinality(v_ids), 0); end if;
    v_other_shift := case when v_shift = 'night' then 'day' else 'night' end;
    select s.id into v_other_site from public.sites s where s.company_id = v_co and s.id <> v_site order by s.name limit 1;
    select r.employee_id into v_stranger from public.sites s cross join lateral public.field_site_roster(s.id) r where s.id <> v_site and s.company_id = v_co limit 1;

    -- a clean slate for this shift today, and a pool reliever sent there
    delete from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today;
    delete from public.attendance_records where attendance_date = v_today and employee_id = any (v_ids);
    select e.id into v_rel from public.employees e where e.company_id = v_co and e.category::text = 'reliever' and e.status = 'Active'
       and public.attendance_window_block_reason(e.id, v_today) is null order by e.full_name limit 1;
    if v_rel is not null then
      delete from public.attendance_records where employee_id = v_rel and attendance_date = v_today;
      insert into public.attendance_records (employee_id, attendance_date, status, scheduled_shift, worked_shift, site_id, covering_for_guard_id)
      values (v_rel, v_today, 'present', v_shift, v_shift, v_site, v_ids[1]) returning id into v_rel_rec;
    end if;

    -- the HR login, made 68 HS's supervisor
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    v_sheet := public.field_shift_sheet(v_site, v_shift);
    if not (v_sheet ->> 'can_confirm')::boolean or jsonb_array_length(v_sheet -> 'guards') <> cardinality(v_ids) then
      raise exception '0613 REFUSED: the sheet says can_confirm %, % guards (expected %): %.', v_sheet ->> 'can_confirm', jsonb_array_length(v_sheet -> 'guards'), cardinality(v_ids), v_sheet ->> 'why_not';
    end if;
    if v_rel is not null and jsonb_array_length(v_sheet -> 'relievers') <> 1 then raise exception '0613 REFUSED: the sheet shows % relievers, not the one sent.', jsonb_array_length(v_sheet -> 'relievers'); end if;
    select string_agg(k, ', ') into v_bad from jsonb_object_keys(v_sheet) k where not (k = any (v_sheet_keys));
    if v_bad is not null then raise exception '0613 REFUSED: field_shift_sheet returns unlisted key(s) %.', v_bad; end if;
    select string_agg(distinct k, ', ') into v_bad from jsonb_array_elements(v_sheet -> 'guards') x, jsonb_object_keys(x) k where not (k = any (v_guard_keys));
    if v_bad is not null then raise exception '0613 REFUSED: sheet guards carry unlisted key(s) %.', v_bad; end if;
    select string_agg(distinct k, ', ') into v_bad from jsonb_array_elements(v_sheet -> 'relievers') x, jsonb_object_keys(x) k where not (k = any (v_rel_keys));
    if v_bad is not null then raise exception '0613 REFUSED: sheet relievers carry unlisted key(s) %.', v_bad; end if;

    -- confirm: absent, leave, double duty, the rest present; the reliever did not arrive
    v_res := public.field_confirm_shift(v_site, v_shift,
      jsonb_build_array(jsonb_build_object('employee_id', v_ids[1], 'status', 'absent'),
                        jsonb_build_object('employee_id', v_ids[2], 'status', 'leave'),
                        jsonb_build_object('employee_id', v_ids[3], 'status', 'double_duty', 'other_shift', v_other_shift)),
      case when v_rel_rec is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('record_id', v_rel_rec, 'arrived', false)) end);
    set constraints all immediate;
    set constraints all deferred;
    if not exists (select 1 from public.attendance_records where employee_id = v_ids[1] and attendance_date = v_today and status = 'absent' and worked_shift = v_shift and source = 'app')
       or not exists (select 1 from public.attendance_records where employee_id = v_ids[2] and attendance_date = v_today and status = 'leave')
       or (select count(*) from public.attendance_records where employee_id = v_ids[3] and attendance_date = v_today and status = 'double_duty') <> 2
       or (select count(*) from public.attendance_records where employee_id = any (v_ids[4:]) and attendance_date = v_today and status = 'present' and worked_shift = v_shift) <> cardinality(v_ids) - 3 then
      raise exception '0613 REFUSED: the confirmation wrote the wrong rows: %.', v_res;
    end if;
    if not exists (select 1 from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift
                    and attendance_date = v_today and source = 'app' and confirmed_by = v_hr
                    and supervisor_name = (select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = v_hr)) then
      raise exception '0613 REFUSED: no app confirmation in the supervisor''s name.';
    end if;
    if v_rel_rec is not null then
      if not exists (select 1 from public.reliever_arrivals where attendance_record_id = v_rel_rec and arrived = false and confirmed_by = v_hr)
         or not exists (select 1 from public.alerts where ref_table = 'reliever_arrivals' and ref_id = v_rel_rec and state = 'open' and message like '% did not arrive. %')
         or not exists (select 1 from public.attendance_records where id = v_rel_rec and status = 'present') then
        raise exception '0613 REFUSED: a reliever who did not arrive was not recorded, did not alert, or lost the office''s mark.';
      end if;
    end if;

    -- re-confirm all present: exactly one present row per guard on this shift
    v_res := public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb);
    set constraints all immediate;
    set constraints all deferred;
    select count(*) into v_n from public.attendance_records where employee_id = any (v_ids) and attendance_date = v_today;
    if v_n <> cardinality(v_ids) or exists (select 1 from public.attendance_records where employee_id = any (v_ids) and attendance_date = v_today and status <> 'present') then
      raise exception '0613 REFUSED: re-confirming all present left % rows for % guards.', v_n, cardinality(v_ids);
    end if;

    -- refusals, each by its message
    v_msg := null; begin perform public.field_confirm_shift(v_site, v_shift, jsonb_build_array(jsonb_build_object('employee_id', v_stranger, 'status', 'absent')), '[]'::jsonb);
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That guard is not on this shift.' then raise exception '0613 REFUSED: a guard from another site got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_confirm_shift(v_other_site, v_shift, '[]'::jsonb, '[]'::jsonb); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0613 REFUSED: another site got "%".', v_msg; end if;

    update public.attendance_confirmations set confirmed_by = v_boss, supervisor_name = 'Office test'
     where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today;
    v_msg := null; begin perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Already confirmed by the office (Office test). Ask the office to change it.' then raise exception '0613 REFUSED: an office-confirmed shift let the phone through: "%".', v_msg; end if;
    if (public.field_shift_sheet(v_site, v_shift) ->> 'can_confirm')::boolean then raise exception '0613 REFUSED: the sheet offers an office-confirmed shift.'; end if;

    -- an office login (field.app) sees the sheet and may not confirm
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_sheet := public.field_shift_sheet(v_site, v_shift);
    if (v_sheet ->> 'can_confirm')::boolean then raise exception '0613 REFUSED: the sheet offers an office login a confirmation.'; end if;
    v_msg := null; begin perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'The office confirms attendance on the Attendance Board; only a site supervisor confirms in the field app.' then
      raise exception '0613 REFUSED: an office login confirming got "%".', v_msg;
    end if;
    raise exception '0613-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0613-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0613 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0613 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0613 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
