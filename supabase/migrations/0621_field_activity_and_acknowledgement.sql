-- 0621 — everything done in the field app is logged, and the office acknowledges it
--
-- DECIDED by Shayan, 30 Oct 2026: "everything done through the app needs [a
-- step] in web — it records at that time, and not exactly an approval but an
-- acknowledgement that this, this and this was done in the mobile application."
-- And: "I will decide who can approve what."
--
-- So the record is made at once (attendance rows, visits, incidents … exactly as
-- 0613–0620 write them), and ALSO a line in field_activity: what, where, who,
-- when, the phone's position, and the record it points at. The office
-- acknowledges lines on Workforce › Field Activity — one, or a whole day.
--
-- WHO acknowledges WHAT is data, not code: field_ack_rules maps each kind to the
-- permission keys whose holders may acknowledge it, editable by a super admin on
-- that page. The seeds below are a starting point only; super admins may always
-- acknowledge.
--
-- Some kinds already have a real decision, and that decision IS the
-- acknowledgement (no double handling): a site's attendance (accepted/returned,
-- 0618), a formal warning (approved/refused, 0617), and — in 0622–0624 — expense
-- and advance requests, employee updates and documents. Their lines are marked
-- acknowledged by the decision, in its decider's name.
--
-- How lines are written: triggers on the tables the app writes (source 'app'),
-- so no field_* function has to remember to log; field_set_guard_photo gets one
-- surgical line because a photo leaves no 'app' marker on employees. One line per
-- (record, kind): confirming a shift again refreshes its line and clears any
-- acknowledgement, because what was acknowledged has changed.
--
-- Money: a line about an expense or advance request carries its amount, so those
-- lines are readable only by their author and by field.money_approve (0622).
--
-- Not acknowledged within 24 hours: one alert a day per company with the count
-- (cron 'field-activity-overdue'). 24 hours is my default; Shayan may change it.
--
-- Asserted under a sentinel: a visit and a site confirmation each write a line; a
-- login holding none of the rule's keys cannot acknowledge, by message; a super
-- admin can; accepting the attendance on review acknowledges its line in the
-- reviewer's name; re-confirming clears it; a rule change lets the HR login in.

-- -------------------------------------------------------------- the log
create table if not exists public.field_activity (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies (id),
  kind         text not null,
  ref_table    text not null,
  ref_id       uuid not null,
  site_id      uuid references public.sites (id),
  actor_id     uuid references public.profiles (id),
  actor_name   text,
  actor_kind   text check (actor_kind in ('supervisor', 'office')),
  summary      text not null,
  geo          jsonb,
  created_at   timestamptz not null default now(),
  ack_by       uuid references public.profiles (id),
  ack_by_name  text,
  ack_at       timestamptz,
  ack_note     text,
  unique (ref_table, ref_id, kind)
);
create index if not exists field_activity_open on public.field_activity (company_id, created_at) where ack_at is null;
comment on table public.field_activity is
  '0621: one line per thing done in the field app (DECIDED 30 Oct 2026): written at once, acknowledged on the web by a holder of field_ack_rules.any_of for its kind (super admins always). Kinds with a real decision (attendance review, formal warning, money requests, employee updates, documents) are acknowledged by that decision.';
alter table public.field_activity enable row level security;
drop policy if exists field_activity_read on public.field_activity;
create policy field_activity_read on public.field_activity for select using (
  company_id = (select public.current_company_id()) and not (select public.is_site_supervisor())
  and (kind not in ('expense', 'advance') or actor_id = (select auth.uid()) or (select public.has_perm('field.money_approve'))));
revoke all on public.field_activity from anon;
grant select on public.field_activity to authenticated;

create table if not exists public.field_ack_rules (
  company_id uuid not null references public.companies (id),
  kind       text not null,
  any_of     text[] not null default '{}',
  label      text not null,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  primary key (company_id, kind)
);
comment on table public.field_ack_rules is
  '0621: who may acknowledge each kind of field-app activity — holders of any key in any_of (super admins always). DECIDED 30 Oct 2026: Shayan decides; the seeded keys are a starting point he changes on Workforce › Field Activity.';
alter table public.field_ack_rules enable row level security;
drop policy if exists field_ack_rules_read on public.field_ack_rules;
create policy field_ack_rules_read on public.field_ack_rules for select using (company_id = (select public.current_company_id()));
revoke all on public.field_ack_rules from anon;
grant select on public.field_ack_rules to authenticated;

insert into public.permission_keys (key, grp, label) values
  ('field.money_approve', 'Field app', 'Field: approve or return expense and advance requests from the app')
on conflict (key) do nothing;

insert into public.field_ack_rules (company_id, kind, any_of, label)
select c.id, r.kind, r.any_of, r.label
  from public.companies c
  cross join (values
    ('attendance',      '{attendance.field_review}'::text[], 'Site attendance (acknowledged by the review)'),
    ('visit',           '{incidents.edit}'::text[],          'Site visits'),
    ('incident',        '{incidents.edit}'::text[],          'Incidents'),
    ('sos',             '{incidents.edit}'::text[],          'SOS'),
    ('warning',         '{warnings.approve}'::text[],        'Warnings (formal ones acknowledged by approval)'),
    ('task',            '{incidents.edit}'::text[],          'Site tasks done / couldn''t'),
    ('site_report',     '{roster.edit}'::text[],             'Daily site reports'),
    ('office_report',   '{roster.edit}'::text[],             'Daily Report notes from the app'),
    ('guard_photo',     '{employees.edit}'::text[],          'Guard photos'),
    ('expense',         '{field.money_approve}'::text[],     'Expense requests (acknowledged by the decision)'),
    ('advance',         '{field.money_approve}'::text[],     'Advance requests (acknowledged by the decision)'),
    ('trip',            '{field.money_approve}'::text[],     'Trips'),
    ('employee_update', '{employees.edit}'::text[],          'Employee details (acknowledged by applying or refusing)'),
    ('document',        '{employees.edit}'::text[],          'Scanned documents (acknowledged by accepting or rejecting)')
  ) as r(kind, any_of, label)
on conflict (company_id, kind) do nothing;

-- -------------------------------------------------------------- writing and acknowledging lines (internal)
create or replace function public.field_log(p_kind text, p_ref_table text, p_ref_id uuid, p_site_id uuid, p_summary text, p_geo jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0621. Internal: one line per (record, kind); writing it again refreshes it and clears its acknowledgement.
  -- tenant guard [exempt]: internal, revoked from every API role; the line takes the caller's own company.
  declare v_name text;
  begin
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    insert into public.field_activity (company_id, kind, ref_table, ref_id, site_id, actor_id, actor_name, actor_kind, summary, geo)
    values (public.current_company_id(), p_kind, p_ref_table, p_ref_id, p_site_id, auth.uid(), v_name,
            case when public.is_site_supervisor() then 'supervisor' else 'office' end, p_summary, p_geo)
    on conflict (ref_table, ref_id, kind) do update
      set summary = excluded.summary, geo = excluded.geo, actor_id = excluded.actor_id, actor_name = excluded.actor_name,
          actor_kind = excluded.actor_kind, created_at = now(), ack_by = null, ack_by_name = null, ack_at = null, ack_note = null;
  end $$;
comment on function public.field_log(text, text, uuid, uuid, text, jsonb) is
  'TENANT GUARD EXEMPT: internal (0621) — writes or refreshes the field_activity line for a record.';
revoke all on function public.field_log(text, text, uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.field_ack_ref(p_ref_table text, p_ref_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0621. Internal: a decision elsewhere acknowledges the record's open lines, in the decider's name.
  -- tenant guard [exempt]: internal, revoked from every API role; touches only the record's own lines.
  begin
    update public.field_activity
       set ack_by = auth.uid(), ack_at = now(), ack_note = p_note,
           ack_by_name = (select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = auth.uid())
     where ref_table = p_ref_table and ref_id = p_ref_id and ack_at is null;
  end $$;
comment on function public.field_ack_ref(text, uuid, text) is
  'TENANT GUARD EXEMPT: internal (0621) — marks a record''s field_activity lines acknowledged by the decision that settled it.';
revoke all on function public.field_ack_ref(text, uuid, text) from public, anon, authenticated;

-- -------------------------------------------------------------- triggers on what the app writes
create or replace function public.field_activity_from_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- 0621. Logs a field-app write as a field_activity line (and acknowledges decided ones).
declare v_site text;
begin
  if tg_table_name = 'attendance_confirmations' then
    if new.source::text = 'app' and (tg_op = 'INSERT' or old.confirmed_at is distinct from new.confirmed_at) then
      select name into v_site from public.sites where id = new.site_id;
      perform public.field_log('attendance', 'attendance_confirmations', new.id, new.site_id,
        coalesce(v_site, 'Site') || ' — ' || new.shift_code || ' shift ' || to_char(new.attendance_date, 'DD Mon') || ' confirmed by ' || new.supervisor_name, new.geo);
    elsif tg_op = 'UPDATE' and new.review_status in ('accepted', 'returned') and old.review_status is distinct from new.review_status then
      perform public.field_ack_ref('attendance_confirmations', new.id, 'Site attendance ' || new.review_status || ' on review');
    end if;
  elsif tg_table_name = 'supervisor_visits' then
    if new.source = 'app' then
      select name into v_site from public.sites where id = new.site_id;
      perform public.field_log('visit', 'supervisor_visits', new.id, new.site_id,
        'Visit at ' || coalesce(v_site, 'a site') || ': ' || coalesce(new.guards_checked, 0) || ' guards checked, '
          || case when coalesce(new.issues, 0) = 0 then 'all fine' else new.issues || ' wrong' end, new.geo);
    end if;
  elsif tg_table_name = 'incidents' then
    if new.source = 'app' then
      select name into v_site from public.sites where id = new.site_id;
      perform public.field_log(case when new.is_sos then 'sos' else 'incident' end, 'incidents', new.id, new.site_id,
        case when new.is_sos then 'SOS at ' || coalesce(v_site, 'a site')
             else initcap(replace(new.category::text, '_', ' ')) || ' (' || new.severity::text || ') at ' || coalesce(v_site, 'a site') end, new.geo);
    end if;
  elsif tg_table_name = 'disciplinary_warnings' then
    if tg_op = 'INSERT' and new.source = 'app' then
      perform public.field_log('warning', 'disciplinary_warnings', new.id, new.site_id,
        initcap(new.kind) || ' warning for ' || (select full_name || ' (' || employee_code || ')' from public.employees where id = new.employee_id)
          || ': ' || new.reason, null);
    elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status <> 'pending' then
      perform public.field_ack_ref('disciplinary_warnings', new.id, 'Formal warning ' || new.status);
    end if;
  elsif tg_table_name = 'site_tasks' then
    if tg_op = 'UPDATE' and old.status = 'open' and new.status in ('done', 'couldnt') then
      select name into v_site from public.sites where id = new.site_id;
      perform public.field_log('task', 'site_tasks', new.id, new.site_id,
        '"' || new.title || '" at ' || coalesce(v_site, 'a site') || ': ' || case when new.status = 'done' then 'done' else 'couldn''t — ' || coalesce(new.done_note, '') end, new.geo);
    end if;
  elsif tg_table_name = 'site_daily_reports' then
    select name into v_site from public.sites where id = new.site_id;
    perform public.field_log('site_report', 'site_daily_reports', new.id, new.site_id,
      'Daily report for ' || coalesce(v_site, 'a site') || ': ' || case when new.all_ok then 'all OK' else 'not OK' || case when new.urgent then ' (urgent)' else '' end || ' — ' || coalesce(new.note, '') end, new.geo);
  end if;
  return null;
end $$;
comment on function public.field_activity_from_row() is
  'TENANT GUARD EXEMPT: trigger (0621) — field-app writes become field_activity lines; decisions acknowledge them.';

drop trigger if exists trg_field_activity on public.attendance_confirmations;
create trigger trg_field_activity after insert or update on public.attendance_confirmations for each row execute function public.field_activity_from_row();
drop trigger if exists trg_field_activity on public.supervisor_visits;
create trigger trg_field_activity after insert on public.supervisor_visits for each row execute function public.field_activity_from_row();
drop trigger if exists trg_field_activity on public.incidents;
create trigger trg_field_activity after insert on public.incidents for each row execute function public.field_activity_from_row();
drop trigger if exists trg_field_activity on public.disciplinary_warnings;
create trigger trg_field_activity after insert or update on public.disciplinary_warnings for each row execute function public.field_activity_from_row();
drop trigger if exists trg_field_activity on public.site_tasks;
create trigger trg_field_activity after update on public.site_tasks for each row execute function public.field_activity_from_row();
drop trigger if exists trg_field_activity on public.site_daily_reports;
create trigger trg_field_activity after insert or update on public.site_daily_reports for each row execute function public.field_activity_from_row();

-- field_set_guard_photo (one author: 0614) logs its photo — surgery, one line.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.field_set_guard_photo(uuid, uuid, text)'::regprocedure);
  a_old constant text := $a$    if n <> 1 then raise exception 'He already has a photo. Ask the office to change it.'; end if;$a$;
  a_new constant text := $a$    if n <> 1 then raise exception 'He already has a photo. Ask the office to change it.'; end if;
    -- 0621: logged for the office to acknowledge.
    perform public.field_log('guard_photo', 'employees', p_employee_id, p_site_id,
      'Photo taken of ' || (select full_name || ' (' || employee_code || ')' from public.employees where id = p_employee_id), null);$a$;
  v_n int;
begin
  if position('-- 0621: logged for the office' in v_def) > 0 then return; end if;
  v_n := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_n <> 1 then raise exception '0621 REFUSED: field_set_guard_photo anchor appears % times, not once.', v_n; end if;
  execute replace(v_def, a_old, a_new);
end $surgery$;

-- -------------------------------------------------------------- the office acknowledges
create or replace function public.acknowledge_field_activity(p_ids uuid[], p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0621. Acknowledge lines the caller may acknowledge (its kind's rule, or a super admin).
  declare v_name text; v_bad text; n int;
  begin
    if coalesce(cardinality(p_ids), 0) = 0 then return 0; end if;
    -- tenant guard [resolved]: every line's company (checked per line below; a foreign line is refused).
    if exists (select 1 from public.field_activity a where a.id = any (p_ids) and a.company_id is distinct from public.current_company_id()) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    select string_agg(distinct coalesce(r.label, a.kind), ', ') into v_bad
      from public.field_activity a
      left join public.field_ack_rules r on r.company_id = a.company_id and r.kind = a.kind
     where a.id = any (p_ids)
       and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('super_admin', 'super_super_admin'))
       and not exists (select 1 from unnest(coalesce(r.any_of, '{}')) k where public.has_perm(k));
    if v_bad is not null then
      raise exception 'You can''t acknowledge: %. Ask a super admin to add you to it on Field Activity › Who acknowledges.', v_bad using errcode = '42501';
    end if;
    select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
    update public.field_activity set ack_by = auth.uid(), ack_by_name = v_name, ack_at = now(), ack_note = nullif(btrim(p_note), '')
     where id = any (p_ids) and ack_at is null;
    get diagnostics n = row_count;
    return n;
  end $$;
comment on function public.acknowledge_field_activity(uuid[], text) is
  '0621: acknowledges field_activity lines; each line''s kind must allow the caller (field_ack_rules.any_of; super admins always).';
revoke all on function public.acknowledge_field_activity(uuid[], text) from public, anon;
grant execute on function public.acknowledge_field_activity(uuid[], text) to authenticated;

create or replace function public.admin_set_field_ack_rule(p_kind text, p_any_of text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0621. A super admin decides which keys may acknowledge a kind.
  declare n int;
  begin
    if not exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin') then
      raise exception 'Only a super admin can decide who acknowledges what.' using errcode = '42501';
    end if;
    if exists (select 1 from unnest(coalesce(p_any_of, '{}')) k where not exists (select 1 from public.permission_keys pk where pk.key = k)) then
      raise exception 'That is not a permission the grant screen offers.';
    end if;
    update public.field_ack_rules set any_of = coalesce(p_any_of, '{}'), updated_by = auth.uid(), updated_at = now()
     where company_id = public.current_company_id() and kind = p_kind;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Row not found' using errcode = '42501'; end if;
  end $$;
comment on function public.admin_set_field_ack_rule(text, text[]) is '0621: super admin sets which permission keys may acknowledge a kind of field-app activity.';
revoke all on function public.admin_set_field_ack_rule(text, text[]) from public, anon;
grant execute on function public.admin_set_field_ack_rule(text, text[]) to authenticated;

create or replace function public.field_activity_overdue()
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0621. Daily: lines not acknowledged within 24 hours — one alert per company, with the count.
  -- tenant guard [exempt]: cron only, revoked from every API role; each alert goes to the line's own company.
  declare c record; n int := 0;
  begin
    for c in select a.company_id, count(*) as k, (array_agg(a.id order by a.created_at))[1] as oldest
               from public.field_activity a where a.ack_at is null and a.created_at < now() - interval '24 hours'
              group by a.company_id loop
      perform public.raise_alert(c.company_id, 'dashboard', 'field',
        c.k || ' thing' || case when c.k = 1 then '' else 's' end || ' done in the field app '
          || case when c.k = 1 then 'has' else 'have' end || ' not been acknowledged in 24 hours. See Workforce › Field Activity.',
        'field_activity', c.oldest, null);
      n := n + 1;
    end loop;
    return n;
  end $$;
comment on function public.field_activity_overdue() is
  'TENANT GUARD EXEMPT: cron only (0621) — alerts once a day per company for field-app activity not acknowledged in 24 hours.';
revoke all on function public.field_activity_overdue() from public, anon, authenticated;
do $cron$ begin
  if not exists (select 1 from cron.job where jobname = 'field-activity-overdue') then
    perform cron.schedule('field-activity-overdue', '0 4 * * *', 'select public.field_activity_overdue()');
  end if;
end $cron$;

insert into public.api_function_gates (function_name, any_of, reason) values
  ('acknowledge_field_activity', null, 'EXEMPT 0621: each line''s field_ack_rules checked inside'),
  ('admin_set_field_ack_rule', '{users.manage}', '0621: super admin checked inside')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_today date := (now() at time zone 'Asia/Karachi')::date;
  v_guard uuid; v_shift text; v_ids uuid[]; v_visit uuid; v_line uuid; v_conf uuid; v_cline uuid; v_msg text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id into v_guard from public.field_site_roster(v_site) r order by r.full_name limit 1;
    select r.shift into v_shift from public.field_site_roster(v_site) r group by r.shift order by count(*) desc limit 1;
    select array_agg(r.employee_id) into v_ids from public.field_site_roster(v_site) r where r.shift = v_shift;

    -- an office visit writes a line
    v_visit := (public.field_record_visit(v_site, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'checks', '{"present": true}'::jsonb)),
                                          '{}'::jsonb, null, null, '{}', null) ->> 'id')::uuid;
    select id into v_line from public.field_activity where ref_table = 'supervisor_visits' and ref_id = v_visit and kind = 'visit' and actor_kind = 'office' and ack_at is null;
    if v_line is null then raise exception '0621 REFUSED: a visit wrote no field_activity line.'; end if;

    -- a supervisor's confirmation writes one; the review acknowledges it
    delete from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today;
    delete from public.attendance_records where attendance_date = v_today and employee_id = any (v_ids);
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb, null);
    select id into v_conf from public.attendance_confirmations where company_id = v_co and group_key = v_site::text and shift_code = v_shift and attendance_date = v_today;
    select id into v_cline from public.field_activity where ref_table = 'attendance_confirmations' and ref_id = v_conf and actor_kind = 'supervisor' and ack_at is null;
    if v_cline is null then raise exception '0621 REFUSED: a site confirmation wrote no line.'; end if;

    -- the HR login (office, field.app only) cannot acknowledge a visit; a super admin can
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'office_staff', site_scope = '{}', permissions = array['field.app'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.acknowledge_field_activity(array[v_line], null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'You can''t acknowledge: Site visits. Ask a super admin to add you to it on Field Activity › Who acknowledges.' then
      raise exception '0621 REFUSED: acknowledging without the rule''s key got "%".', v_msg;
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.admin_set_field_ack_rule('visit', array['field.app']);
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    if public.acknowledge_field_activity(array[v_line], 'Seen') <> 1
       or not exists (select 1 from public.field_activity where id = v_line and ack_by = v_hr and ack_note = 'Seen') then
      raise exception '0621 REFUSED: after the rule change the HR login could not acknowledge.';
    end if;

    -- accepting the attendance acknowledges its line; confirming again would clear it
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.review_field_attendance(v_conf, true, null);
    if not exists (select 1 from public.field_activity where id = v_cline and ack_by = v_boss and ack_at is not null) then
      raise exception '0621 REFUSED: accepting the attendance did not acknowledge its line.';
    end if;
    update public.attendance_confirmations set review_status = 'returned' where id = v_conf;
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site], permissions = '{}' where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform public.field_confirm_shift(v_site, v_shift, '[]'::jsonb, '[]'::jsonb, null);
    if exists (select 1 from public.field_activity where id = v_cline and ack_at is not null) then
      raise exception '0621 REFUSED: confirming again did not clear the acknowledgement.';
    end if;
    raise exception '0621-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0621-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0621 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0621 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0621 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
