-- 0625 — the office Daily Report from the phone, and the CEO's snapshot
--
-- DAILY REPORT. Shayan, 30 Oct 2026: "make daily report and export it" — the
-- Daily Report "which already exists in Bastion web" (Operations › Daily Reports:
-- one note per active client per day, PDF). The phone writes the SAME rows
-- (daily_client_reports) under the SAME key the web needs (roster.edit), for
-- today only — a past day is a record on the web too. The phone builds and
-- shares the PDF itself. Each client's note is a field_activity line.
--
--   field_daily_clients()                         today's clients (the caller's region if pinned) and notes
--   field_save_client_report(client, details, no_report, urgent)
--
-- CEO SNAPSHOT. Shayan: "the CEO's app is just to give a snapshot of the Ops
-- side of data … and minor expenses" — viewing only (DECIDED). One read,
-- field.snapshot (new). Money in it: this week's recorded expenses (count, total,
-- the five largest) and the app's pending requests — read-only figures, with no
-- path from the app into the money tables.
--
--   field_snapshot()
--
-- field_abilities (one author: 0620) gains the new abilities by surgery on its
-- list: expenses, trips, employees, office_report (roster.edit), snapshot.
--
-- Asserted under a sentinel: an office login with roster.edit sees today's
-- clients and saves a note (logged), a pinned login sees only its region's; one
-- without roster.edit is refused by message; a supervisor is refused; the
-- snapshot needs field.snapshot and returns its sections; abilities list the new
-- keys for a super admin.

insert into public.permission_keys (key, grp, label) values
  ('field.snapshot', 'Field app', 'Field: the operations snapshot (CEO) — viewing only')
on conflict (key) do nothing;

-- -------------------------------------------------------------- the office Daily Report
create or replace function public.field_daily_clients()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0625. Today's Daily Report: active clients (the caller's region when pinned) and today's notes.
  declare v_branch uuid;
  begin
    perform public.field_require('roster.edit');
    select branch_id into v_branch from public.profiles where id = auth.uid();
    return jsonb_build_object('date', public.field_today(),
      'region', (select name from public.branches where id = v_branch),
      'clients', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'name', c.name, 'region', b.name,
          'details', r.details, 'no_report', coalesce(r.no_report, false), 'urgent', coalesce(r.urgent, false)) order by c.name), '[]'::jsonb)
        from public.clients c
        left join public.branches b on b.id = c.branch_id
        left join public.daily_client_reports r on r.client_id = c.id and r.report_date = public.field_today()
       where c.company_id = public.current_company_id()
         and exists (select 1 from public.contracts k where k.client_id = c.id and k.status = 'active')
         and (v_branch is null or c.branch_id = v_branch)));
  end $$;
comment on function public.field_daily_clients() is '0625: today''s Daily Report clients and notes for the field app (roster.edit, region when pinned).';

create or replace function public.field_save_client_report(p_client_id uuid, p_details text, p_no_report boolean default false, p_urgent boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0625. Today's note for one client — the same row the web's Daily Reports writes.
  declare v_id uuid; v_branch uuid; v_client record;
  begin
    perform public.field_require('roster.edit');
    -- tenant guard [resolved]: the client's company; then the caller's region when pinned.
    perform public.assert_same_company((select c.company_id from public.clients c where c.id = p_client_id));
    select branch_id into v_branch from public.profiles where id = auth.uid();
    select id, name, branch_id into v_client from public.clients where id = p_client_id;
    if v_branch is not null and v_client.branch_id is distinct from v_branch then raise exception 'Row not found' using errcode = '42501'; end if;
    insert into public.daily_client_reports (company_id, client_id, report_date, details, no_report, urgent, updated_by, updated_at)
    values (public.current_company_id(), p_client_id, public.field_today(),
            case when coalesce(p_no_report, false) then null else nullif(btrim(p_details), '') end,
            coalesce(p_no_report, false), not coalesce(p_no_report, false) and coalesce(p_urgent, false), auth.uid(), now())
    on conflict (company_id, client_id, report_date) do update
      set details = excluded.details, no_report = excluded.no_report, urgent = excluded.urgent, updated_by = excluded.updated_by, updated_at = now()
    returning id into v_id;
    perform public.field_log('office_report', 'daily_client_reports', v_id, null,
      'Daily Report note for ' || v_client.name || ': ' || case when coalesce(p_no_report, false) then 'no report'
        else coalesce(left(btrim(p_details), 140), '—') || case when coalesce(p_urgent, false) then ' (urgent)' else '' end end, null);
  end $$;
comment on function public.field_save_client_report(uuid, text, boolean, boolean) is '0625: the field app writes today''s Daily Report note for a client (roster.edit) — the same daily_client_reports row as the web.';

-- -------------------------------------------------------------- the CEO's snapshot
create or replace function public.field_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0625. One read of today's operations and this week's minor expenses. Viewing only.
  declare v_co uuid := public.current_company_id(); v_today date := public.field_today(); v_week date := public.field_today() - 6;
  begin
    perform public.field_require('field.snapshot');
    return jsonb_build_object(
      'date', v_today,
      'attendance', jsonb_build_object(
        'shifts_confirmed', (select count(*) from public.attendance_confirmations where company_id = v_co and attendance_date = v_today),
        'from_app_waiting_review', (select count(*) from public.attendance_confirmations where company_id = v_co and review_status = 'pending'),
        'absent', (select count(*) from public.attendance_records a join public.employees e on e.id = a.employee_id
                    where e.company_id = v_co and a.attendance_date = v_today and a.status = 'absent'),
        'on_leave', (select count(distinct a.employee_id) from public.attendance_records a join public.employees e on e.id = a.employee_id
                      where e.company_id = v_co and a.attendance_date = v_today and public.attendance_status_is_leave(a.status)),
        'relievers_sent', (select count(*) from public.attendance_records a join public.employees e on e.id = a.employee_id
                            where e.company_id = v_co and a.attendance_date = v_today and e.category::text = 'reliever' and a.site_id is not null and a.status = 'present')),
      'incidents', jsonb_build_object(
        'open', (select count(*) from public.incidents where company_id = v_co and status in ('open', 'under_investigation')),
        'sos_7_days', (select count(*) from public.incidents where company_id = v_co and is_sos and occurred_at >= now() - interval '7 days'),
        'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', i.occurred_at, 'category', i.category, 'severity', i.severity, 'is_sos', i.is_sos,
                                    'site', (select name from public.sites where id = i.site_id), 'client', (select name from public.clients where id = i.client_id))
                                    order by i.occurred_at desc), '[]'::jsonb)
                     from (select * from public.incidents where company_id = v_co and occurred_at >= now() - interval '7 days' order by occurred_at desc limit 5) i)),
      'people', jsonb_build_object(
        'warnings_waiting', (select count(*) from public.disciplinary_warnings where company_id = v_co and status = 'pending'),
        'termination_review', (select count(*) from public.employees where company_id = v_co and pending_termination_review and lifecycle_state::text = 'active')),
      'field', jsonb_build_object(
        'visits_today', (select count(*) from public.supervisor_visits where company_id = v_co and completed_at >= v_today and source = 'app'),
        'visits_week', (select count(*) from public.supervisor_visits where company_id = v_co and completed_at >= v_week and source = 'app'),
        'issues_week', (select coalesce(sum(issues), 0) from public.supervisor_visits where company_id = v_co and completed_at >= v_week and source = 'app'),
        'tasks_open', (select count(*) from public.site_tasks where company_id = v_co and status = 'open'),
        'tasks_overdue', (select count(*) from public.site_tasks where company_id = v_co and status = 'open' and due_date < v_today),
        'not_acknowledged', (select count(*) from public.field_activity where company_id = v_co and ack_at is null),
        'daily_report_clients_today', (select count(*) from public.daily_client_reports where company_id = v_co and report_date = v_today)),
      'expenses', jsonb_build_object(
        'week_count', (select count(*) from public.expenses where company_id = v_co and expense_date between v_week and v_today),
        'week_total', (select coalesce(sum(amount), 0) from public.expenses where company_id = v_co and expense_date between v_week and v_today),
        'largest', (select coalesce(jsonb_agg(jsonb_build_object('date', x.expense_date, 'amount', x.amount, 'description', x.description,
                                    'category', (select name from public.expense_categories where id = x.category_id)) order by x.amount desc), '[]'::jsonb)
                      from (select * from public.expenses where company_id = v_co and expense_date between v_week and v_today order by amount desc limit 5) x),
        'app_requests_waiting', (select count(*) from public.field_money_requests where company_id = v_co and status = 'pending'),
        'app_requests_waiting_total', (select coalesce(sum(amount), 0) from public.field_money_requests where company_id = v_co and status = 'pending')));
  end $$;
comment on function public.field_snapshot() is
  '0625: the CEO''s operations snapshot for the field app (field.snapshot) — today''s attendance, incidents, people, field work, and this week''s minor expenses. DECIDED 30 Oct 2026: viewing only.';

-- -------------------------------------------------------------- field_abilities gains the new ones (one author: 0620)
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_abilities()'::regprocedure);
  a_old constant text := $a$(4, 'tasks', 'field.tasks'), (5, 'warnings', 'field.warnings')) as a(ord, ability, perm)$a$;
  a_new constant text := $a$(4, 'tasks', 'field.tasks'), (5, 'warnings', 'field.warnings'),
           -- 0625: own money requests, trips, employee files, the office Daily Report, the CEO snapshot
           (6, 'expenses', 'field.expenses'), (7, 'trips', 'field.trips'), (8, 'employees', 'field.employees'),
           (9, 'office_report', 'roster.edit'), (10, 'snapshot', 'field.snapshot')) as a(ord, ability, perm)$a$;
  v_n int;
begin
  if position('-- 0625: own money requests' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0625 REFUSED: field_abilities anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;

revoke all on function public.field_daily_clients() from public, anon;
grant execute on function public.field_daily_clients() to authenticated;
revoke all on function public.field_save_client_report(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.field_save_client_report(uuid, text, boolean, boolean) to authenticated;
revoke all on function public.field_snapshot() from public, anon;
grant execute on function public.field_snapshot() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_daily_clients', null, 'EXEMPT 0625: field_require(roster.edit) inside'),
  ('field_save_client_report', null, 'EXEMPT 0625: field_require(roster.edit) inside'),
  ('field_snapshot', null, 'EXEMPT 0625: field_require(field.snapshot) inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test (and the review list of every field_* function)
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_lahore constant uuid := 'a46fd702-8796-4858-b338-142628ce33cf';
  v_known constant text[] := array['field_abilities', 'field_can_see_employee', 'field_can_see_site', 'field_confirm_shift', 'field_daily_clients',
                                   'field_employee_card', 'field_employee_editable', 'field_employee_search', 'field_expense_categories', 'field_geo',
                                   'field_guard_photo', 'field_guard_warnings', 'field_log', 'field_me', 'field_money_approvers', 'field_my_requests',
                                   'field_office_can', 'field_office_user', 'field_propose_employee_change', 'field_raise_warning', 'field_record_visit',
                                   'field_register_device', 'field_register_push', 'field_report_incident', 'field_request_device', 'field_request_money',
                                   'field_require', 'field_review_escalate', 'field_save_client_report', 'field_set_guard_photo', 'field_shift_sheet',
                                   'field_site_daily', 'field_site_incidents', 'field_site_roster', 'field_site_tasks', 'field_site_visits',
                                   'field_snapshot', 'field_sos', 'field_store_photos', 'field_submit_daily_report', 'field_task_update', 'field_today',
                                   'field_trip_cancel', 'field_trip_end', 'field_trip_start', 'field_trip_state', 'field_upload_document',
                                   'field_activity_from_row', 'field_activity_overdue', 'field_ack_ref'];
  v_client uuid; v_lclient uuid; v_msg text; v_bad text; v_d jsonb; v_s jsonb;
begin
  select string_agg(proname, ', ') into v_bad from pg_proc
   where pronamespace = 'public'::regnamespace and proname ~ '^field_' and not (proname = any (v_known));
  if v_bad is not null then raise exception '0625 REFUSED: field_* function(s) % not reviewed — check and add to the list.', v_bad; end if;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select client_id into v_client from public.sites where id = v_site;
    select c.id into v_lclient from public.clients c where c.company_id = v_co and c.branch_id = v_lahore
       and exists (select 1 from public.contracts k where k.client_id = c.id and k.status = 'active') limit 1;

    -- without roster.edit: refused; with it: today's clients, and a note saved and logged
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_daily_clients(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg not like 'Your login needs the "%" permission for this. Ask a super admin.' then raise exception '0625 REFUSED: no roster.edit got "%".', v_msg; end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['field.app', 'roster.edit'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_d := public.field_daily_clients();
    if not exists (select 1 from jsonb_array_elements(v_d -> 'clients') x where (x ->> 'id')::uuid = v_client) then raise exception '0625 REFUSED: 68 HS''s client is not on today''s list.'; end if;
    perform public.field_save_client_report(v_client, 'All posts manned', false, true);
    if not exists (select 1 from public.daily_client_reports where client_id = v_client and report_date = public.field_today() and details = 'All posts manned' and urgent and updated_by = v_hr)
       or not exists (select 1 from public.field_activity f join public.daily_client_reports r on r.id = f.ref_id
                       where f.kind = 'office_report' and r.client_id = v_client and r.report_date = public.field_today()) then
      raise exception '0625 REFUSED: the note was not saved as the web''s row, or not logged.';
    end if;

    -- pinned to Lahore: only Lahore's clients; another region's client refused
    if v_lclient is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
      update public.profiles set branch_id = v_lahore where id = v_hr;
      perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
      if exists (select 1 from jsonb_array_elements(public.field_daily_clients() -> 'clients') x
                  where (select branch_id from public.clients where id = (x ->> 'id')::uuid) is distinct from v_lahore) then
        raise exception '0625 REFUSED: a Lahore login sees another region''s client.';
      end if;
      if (select branch_id from public.clients where id = v_client) is distinct from v_lahore then
        v_msg := null; begin perform public.field_save_client_report(v_client, 'x', false, false); exception when others then get stacked diagnostics v_msg = message_text; end;
        if v_msg is distinct from 'Row not found' then raise exception '0625 REFUSED: another region''s client got "%".', v_msg; end if;
      end if;
    end if;

    -- the snapshot needs field.snapshot
    v_msg := null; begin perform public.field_snapshot(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Field: the operations snapshot (CEO) — viewing only" permission for this. Ask a super admin.' then
      raise exception '0625 REFUSED: a snapshot without the key got "%".', v_msg;
    end if;

    -- a supervisor is refused
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site], branch_id = null where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.field_daily_clients(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'This is done by the office, not in the site supervisor''s app.' then raise exception '0625 REFUSED: a supervisor got "%".', v_msg; end if;

    -- a super admin: the snapshot's sections, and every ability
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_s := public.field_snapshot();
    if not (v_s ?& array['attendance', 'incidents', 'people', 'field', 'expenses']) then raise exception '0625 REFUSED: the snapshot is missing a section: %.', v_s; end if;
    if not (public.field_me() -> 'can') @> '["expenses", "trips", "employees", "office_report", "snapshot"]'::jsonb then
      raise exception '0625 REFUSED: a super admin''s abilities are %.', public.field_me() -> 'can';
    end if;
    raise exception '0625-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0625-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0625 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0625 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0625 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
