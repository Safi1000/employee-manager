-- 0619 — site tasks and the daily site report, on the field app
--
-- 30 Oct 2026 bundle ("sure" to: the office gives a site a task, the supervisor
-- marks it done; each site sends a short end-of-day report).
--
-- SITE TASKS. The office sets a task on a site ("replace the gate register",
-- "brief the new guard on the back gate"); whoever covers the site on the phone
-- marks it done, or couldn't — with a note — and may add photos. Set and
-- cancelled by a super admin on Operations › Field Supervisors, like the rest of
-- the field accounts (the page is super-admin only today). "Couldn't" alerts.
--
-- DAILY SITE REPORT. One per site per day (Pakistan), the supervisor's own short
-- word: all OK, or what was not, optionally urgent, with photos. Sending again
-- the same day replaces it. Urgent alerts. It is shown to the office on
-- Operations › Daily Reports beside that client's Details box — the office's
-- written note stays the office's; the site's word sits next to it, never in it.
-- (daily_client_reports, the office's note per client, is not written here.)
--
-- Only a site supervisor sends the daily report: an office login visiting a site
-- records a visit (0615), it does not speak for the site's day.
--
--   site_tasks, site_daily_reports            read by office logins of the company
--   admin_site_task_add / admin_site_task_cancel      super admin
--   field_site_tasks(site), field_task_update(task, done, note, photos, geo)
--   field_site_daily(site), field_submit_daily_report(site, all_ok, note, urgent, photos, geo)
--
-- Asserted under a sentinel: a task set by the office appears on the phone, is
-- done with a photo, then refused as already closed; "couldn't" needs a note and
-- alerts; a daily report is sent and replaced the same day; not-OK needs a note;
-- urgent alerts; an office login may not send a site's daily report; another
-- site's task is refused.

-- -------------------------------------------------------------- tables
create table if not exists public.site_tasks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  site_id       uuid not null references public.sites (id),
  title         text not null check (btrim(title) <> ''),
  details       text,
  due_date      date,
  status        text not null default 'open' check (status in ('open', 'done', 'couldnt', 'cancelled')),
  created_by    uuid references public.profiles (id),
  created_by_name text,
  created_at    timestamptz not null default now(),
  done_by       uuid references public.profiles (id),
  done_by_name  text,
  done_at       timestamptz,
  done_note     text,
  geo           jsonb
);
create index if not exists site_tasks_site on public.site_tasks (site_id, status);
comment on table public.site_tasks is
  '0619: a task the office sets on a site; the site''s field login marks it done or couldn''t (with a note, and photos in field_photos ref_table site_tasks). Set/cancelled by a super admin on Field Supervisors.';
alter table public.site_tasks enable row level security;
drop policy if exists site_tasks_read on public.site_tasks;
create policy site_tasks_read on public.site_tasks for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor()));
revoke all on public.site_tasks from anon;
grant select on public.site_tasks to authenticated;

create table if not exists public.site_daily_reports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies (id),
  site_id       uuid not null references public.sites (id),
  client_id     uuid references public.clients (id),
  report_date   date not null,
  all_ok        boolean not null,
  note          text,
  urgent        boolean not null default false,
  sent_by       uuid not null references public.profiles (id),
  sent_by_name  text not null,
  sent_at       timestamptz not null default now(),
  geo           jsonb,
  unique (site_id, report_date)
);
comment on table public.site_daily_reports is
  '0619: a site supervisor''s end-of-day word on his site — all OK or what was not, optionally urgent. One per site per day (Pakistan); sending again replaces it. Shown beside the client on Daily Reports; never written into daily_client_reports.';
alter table public.site_daily_reports enable row level security;
drop policy if exists site_daily_reports_read on public.site_daily_reports;
create policy site_daily_reports_read on public.site_daily_reports for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor()));
revoke all on public.site_daily_reports from anon;
grant select on public.site_daily_reports to authenticated;

-- -------------------------------------------------------------- the office sets tasks
create or replace function public.admin_site_task_add(p_site_id uuid, p_title text, p_details text default null, p_due date default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0619. A super admin sets a task on a site.
  declare v_id uuid;
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can set site tasks.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the site's company.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if nullif(btrim(p_title), '') is null then raise exception 'Say what needs doing.'; end if;
    insert into public.site_tasks (company_id, site_id, title, details, due_date, created_by, created_by_name)
    values (public.current_company_id(), p_site_id, btrim(p_title), nullif(btrim(p_details), ''), p_due, auth.uid(),
            (select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = auth.uid()))
    returning id into v_id;
    return v_id;
  end $$;
comment on function public.admin_site_task_add(uuid, text, text, date) is '0619: super admin sets a task on a site for the field app.';

create or replace function public.admin_site_task_cancel(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0619. A super admin cancels an open site task.
  declare n int;
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can set site tasks.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the task's company.
    perform public.assert_same_company((select company_id from public.site_tasks where id = p_task_id));
    update public.site_tasks set status = 'cancelled' where id = p_task_id and status = 'open';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That task is not open.'; end if;
  end $$;
comment on function public.admin_site_task_cancel(uuid) is '0619: super admin cancels an open site task.';

-- -------------------------------------------------------------- the phone: tasks
create or replace function public.field_site_tasks(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0619. A site's open tasks and those closed in the last 7 days.
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object(
              'id', t.id, 'title', t.title, 'details', t.details, 'due_date', t.due_date, 'status', t.status,
              'created_by_name', t.created_by_name, 'created_at', t.created_at,
              'done_by_name', t.done_by_name, 'done_at', t.done_at, 'done_note', t.done_note)
              order by (t.status = 'open') desc, t.due_date nulls last, t.created_at desc), '[]'::jsonb)
              from public.site_tasks t
             where t.site_id = p_site_id and (t.status = 'open' or (t.status in ('done', 'couldnt') and t.done_at >= now() - interval '7 days')));
  end $$;
comment on function public.field_site_tasks(uuid) is '0619: open tasks at a site the caller can see, and those closed in the last week.';

create or replace function public.field_task_update(p_task_id uuid, p_done boolean, p_note text default null, p_photos text[] default '{}', p_geo jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0619. Mark an open site task done, or couldn't (with a note).
  declare v_t record; v_me record; v_geo jsonb; n int;
  begin
    -- tenant guard [resolved]: the task's company; then field_can_see_site on its site.
    perform public.assert_same_company((select company_id from public.site_tasks where id = p_task_id));
    select t.id, t.site_id, t.title, t.status, s.name as site into v_t from public.site_tasks t join public.sites s on s.id = t.site_id where t.id = p_task_id;
    if v_t.id is null or not public.field_can_see_site(v_t.site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if v_t.status <> 'open' then raise exception 'That task is already closed.'; end if;
    if not p_done and nullif(btrim(p_note), '') is null then raise exception 'Say why it could not be done.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    v_geo := public.field_geo(v_t.site_id, p_geo);
    update public.site_tasks set status = case when p_done then 'done' else 'couldnt' end, done_by = v_me.id, done_by_name = v_me.name,
           done_at = now(), done_note = nullif(btrim(p_note), ''), geo = v_geo
     where id = p_task_id and status = 'open';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That task is already closed.'; end if;
    perform public.field_store_photos(v_t.site_id, 'task', 'site_tasks', p_task_id, p_photos, v_geo);
    if not p_done then
      perform public.raise_alert(public.current_company_id(), 'dashboard', 'field',
        v_t.site || ': ' || v_me.name || ' could not do "' || v_t.title || '" — ' || btrim(p_note) || '.',
        'site_tasks', p_task_id, null);
    end if;
  end $$;
comment on function public.field_task_update(uuid, boolean, text, text[], jsonb) is
  '0619: the field app closes an open site task — done, or couldn''t with a note (which alerts). Photos optional.';

-- -------------------------------------------------------------- the phone: the day's report
create or replace function public.field_site_daily(p_site_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0619. Today's daily report for a site, if sent.
  declare r record;
  begin
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    select all_ok, note, urgent, sent_by_name, sent_at into r from public.site_daily_reports where site_id = p_site_id and report_date = public.field_today();
    return jsonb_build_object('date', public.field_today(), 'can_send', public.is_site_supervisor(),
      'report', case when r.sent_at is null then null else jsonb_build_object(
        'all_ok', r.all_ok, 'note', r.note, 'urgent', r.urgent, 'sent_by_name', r.sent_by_name, 'sent_at', r.sent_at) end);
  end $$;
comment on function public.field_site_daily(uuid) is '0619: today''s daily site report (Pakistan) for a site the caller can see.';

create or replace function public.field_submit_daily_report(p_site_id uuid, p_all_ok boolean, p_note text default null, p_urgent boolean default false,
                                                            p_photos text[] default '{}', p_geo jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0619. A site supervisor's end-of-day word; sending again today replaces it.
  declare v_me record; v_site record; v_id uuid; v_geo jsonb;
  begin
    if not public.is_site_supervisor() then
      raise exception 'Only the site supervisor sends the daily site report.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the site's company; then field_can_see_site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    if not public.field_can_see_site(p_site_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if p_all_ok is null then raise exception 'Say whether all was OK.'; end if;
    if not p_all_ok and nullif(btrim(p_note), '') is null then raise exception 'Say what was not OK.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.id, s.name, s.client_id into v_site from public.sites s where s.id = p_site_id;
    v_geo := public.field_geo(p_site_id, p_geo);
    insert into public.site_daily_reports (company_id, site_id, client_id, report_date, all_ok, note, urgent, sent_by, sent_by_name, sent_at, geo)
    values (public.current_company_id(), p_site_id, v_site.client_id, public.field_today(), p_all_ok, nullif(btrim(p_note), ''),
            coalesce(p_urgent, false) and not p_all_ok, v_me.id, v_me.name, now(), v_geo)
    on conflict (site_id, report_date) do update
      set all_ok = excluded.all_ok, note = excluded.note, urgent = excluded.urgent, sent_by = excluded.sent_by,
          sent_by_name = excluded.sent_by_name, sent_at = excluded.sent_at, geo = excluded.geo
    returning id into v_id;
    delete from public.field_photos where ref_table = 'site_daily_reports' and ref_id = v_id;
    perform public.field_store_photos(p_site_id, 'daily_report', 'site_daily_reports', v_id, p_photos, v_geo);
    if coalesce(p_urgent, false) and not p_all_ok then
      perform public.raise_alert(public.current_company_id(), 'warning', 'field',
        'Urgent from ' || v_site.name || ' (' || v_me.name || '): ' || btrim(p_note), 'site_daily_reports', v_id, null);
    end if;
  end $$;
comment on function public.field_submit_daily_report(uuid, boolean, text, boolean, text[], jsonb) is
  '0619: a site supervisor''s daily site report (today, Pakistan). Not OK needs a note; urgent alerts. Sending again the same day replaces it and its photos.';

revoke all on function public.admin_site_task_add(uuid, text, text, date) from public, anon;
grant execute on function public.admin_site_task_add(uuid, text, text, date) to authenticated;
revoke all on function public.admin_site_task_cancel(uuid) from public, anon;
grant execute on function public.admin_site_task_cancel(uuid) to authenticated;
revoke all on function public.field_site_tasks(uuid) from public, anon;
grant execute on function public.field_site_tasks(uuid) to authenticated;
revoke all on function public.field_task_update(uuid, boolean, text, text[], jsonb) from public, anon;
grant execute on function public.field_task_update(uuid, boolean, text, text[], jsonb) to authenticated;
revoke all on function public.field_site_daily(uuid) from public, anon;
grant execute on function public.field_site_daily(uuid) to authenticated;
revoke all on function public.field_submit_daily_report(uuid, boolean, text, boolean, text[], jsonb) from public, anon;
grant execute on function public.field_submit_daily_report(uuid, boolean, text, boolean, text[], jsonb) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('admin_site_task_add', '{users.manage}', '0619: super admin checked inside'),
  ('admin_site_task_cancel', '{users.manage}', '0619: super admin checked inside'),
  ('field_site_tasks', null, 'EXEMPT 0619: field_can_see_site checked inside'),
  ('field_task_update', null, 'EXEMPT 0619: field_can_see_site checked inside'),
  ('field_site_daily', null, 'EXEMPT 0619: field_can_see_site checked inside'),
  ('field_submit_daily_report', null, 'EXEMPT 0619: site supervisors only, field_can_see_site checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test (and the whole bundle's money review)
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_jpeg  constant text := 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
  -- every field_* function, reviewed 0612–0619 for money and CNIC columns
  v_known constant text[] := array['field_can_see_site', 'field_confirm_shift', 'field_geo', 'field_guard_photo', 'field_guard_warnings',
                                   'field_me', 'field_office_user', 'field_raise_warning', 'field_record_visit', 'field_register_device',
                                   'field_report_incident', 'field_request_device', 'field_review_escalate', 'field_set_guard_photo',
                                   'field_shift_sheet', 'field_site_daily', 'field_site_incidents', 'field_site_roster', 'field_site_tasks',
                                   'field_site_visits', 'field_sos', 'field_store_photos', 'field_submit_daily_report', 'field_task_update',
                                   'field_today'];
  v_cols  constant text[] := array['employee_id', 'full_name', 'employee_code', 'shift', 'phone', 'has_photo', 'flags'];
  v_money constant text := '(salar|wage|amount|pay|fine|cnic_number|cnic$|bank|account_no|iban|balance|rate|cost|price|invoice)';
  v_t1 uuid; v_t2 uuid; v_other_task uuid; v_other_site uuid; v_msg text; v_bad text; v_n int;
begin
  select string_agg(proname, ', ') into v_bad from pg_proc
   where pronamespace = 'public'::regnamespace and proname ~ '^field_' and not (proname = any (v_known));
  if v_bad is not null then raise exception '0619 REFUSED: field_* function(s) % not reviewed for money columns — check and add to the list.', v_bad; end if;
  select string_agg(p.proname || '.' || a.n, ', ') into v_bad
    from pg_proc p cross join lateral unnest(p.proargnames, p.proargmodes) as a(n, m)
   where p.pronamespace = 'public'::regnamespace and p.proname ~ '^field_' and a.m in ('t', 'o') and not (a.n = any (v_cols));
  if v_bad is not null then raise exception '0619 REFUSED: field_* returns unlisted column(s) %.', v_bad; end if;
  -- no field_* body builds a json key that names money
  select string_agg(distinct p.proname || ':' || m[1], ', ') into v_bad
    from pg_proc p cross join lateral regexp_matches(p.prosrc, '''([a-z_]+)'',', 'g') m
   where p.pronamespace = 'public'::regnamespace and p.proname ~ '^field_' and p.proname not in ('field_store_photos')
     and m[1] ~ v_money and p.prosrc ~ 'jsonb_build_object';
  if v_bad is not null then raise exception '0619 REFUSED: field_* builds a key that names money: %.', v_bad; end if;

  begin
    select s.id into v_other_site from public.sites s where s.company_id = v_co and s.id <> v_site order by s.name limit 1;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_t1 := public.admin_site_task_add(v_site, 'Replace the gate register', null, null);
    v_t2 := public.admin_site_task_add(v_site, 'Fix the back light', 'Bulb gone', current_date + 2);
    v_other_task := public.admin_site_task_add(v_other_site, 'Elsewhere', null, null);
    v_msg := null; begin perform public.field_submit_daily_report(v_site, true, null, false, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only the site supervisor sends the daily site report.' then raise exception '0619 REFUSED: an office login sending a daily report got "%".', v_msg; end if;

    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.admin_site_task_add(v_site, 'x', null, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only a super admin can set site tasks.' then raise exception '0619 REFUSED: a supervisor setting a task got "%".', v_msg; end if;
    select count(*) into v_n from jsonb_array_elements(public.field_site_tasks(v_site)) x where x ->> 'status' = 'open';
    if v_n <> 2 then raise exception '0619 REFUSED: the phone shows % open tasks, not 2.', v_n; end if;

    perform public.field_task_update(v_t1, true, 'Done', array[v_jpeg], null);
    if not exists (select 1 from public.site_tasks where id = v_t1 and status = 'done' and done_by = v_hr)
       or (select count(*) from public.field_photos where ref_table = 'site_tasks' and ref_id = v_t1) <> 1 then
      raise exception '0619 REFUSED: a done task or its photo is missing.';
    end if;
    v_msg := null; begin perform public.field_task_update(v_t1, true, null, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That task is already closed.' then raise exception '0619 REFUSED: closing twice got "%".', v_msg; end if;
    v_msg := null; begin perform public.field_task_update(v_t2, false, '', '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Say why it could not be done.' then raise exception '0619 REFUSED: couldn''t with no note got "%".', v_msg; end if;
    perform public.field_task_update(v_t2, false, 'No bulb in stock', '{}', null);
    if not exists (select 1 from public.alerts where ref_table = 'site_tasks' and ref_id = v_t2 and state = 'open') then raise exception '0619 REFUSED: couldn''t did not alert.'; end if;
    v_msg := null; begin perform public.field_task_update(v_other_task, true, null, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0619 REFUSED: another site''s task got "%".', v_msg; end if;

    delete from public.site_daily_reports where site_id = v_site and report_date = public.field_today();
    v_msg := null; begin perform public.field_submit_daily_report(v_site, false, ' ', false, '{}', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Say what was not OK.' then raise exception '0619 REFUSED: not OK with no note got "%".', v_msg; end if;
    perform public.field_submit_daily_report(v_site, true, null, false, '{}', '{"lat": 33.6, "lng": 73.0}');
    perform public.field_submit_daily_report(v_site, false, 'Gate light out', true, array[v_jpeg], null);
    if (select count(*) from public.site_daily_reports where site_id = v_site and report_date = public.field_today()) <> 1
       or not exists (select 1 from public.site_daily_reports where site_id = v_site and report_date = public.field_today() and not all_ok and urgent and note = 'Gate light out')
       or not exists (select 1 from public.alerts a join public.site_daily_reports r on r.id = a.ref_id where a.ref_table = 'site_daily_reports' and r.site_id = v_site and a.state = 'open')
       or (public.field_site_daily(v_site) -> 'report' ->> 'all_ok')::boolean then
      raise exception '0619 REFUSED: the daily report was not replaced, not urgent, or did not alert.';
    end if;
    raise exception '0619-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0619-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0619 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0619 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0619 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
