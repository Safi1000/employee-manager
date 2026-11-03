-- 0638 — import a month of attendance from the Excel sheet.
--
-- Shayan, 3 Nov 2026: the HRO keeps each client's month in a sheet (PCI / 68 HS
-- / PFM, October) and the sheet is the confirmed record. Bastion holds what came
-- in on WhatsApp, which stopped at the 20th. This brings a month in from a file
-- in a fixed format (the template the Attendance board exports), under its own
-- key, with a dry run first and an undo after.
--
-- HOW IT IS SAFE, and the risks each part answers:
--
--   * Its own key, attendance.import. Granted on Access & Governance; in no
--     preset; "All" on the group does not tick it. Super admins hold it.
--   * Guards are named by id, never by name. The frontend reads the guard code
--     off the template and refuses a row it cannot match exactly. A name typed
--     two ways ("Sharfat" / "Sharafat") or two guards with one name ("Ali Raza"
--     ×2 on this client) cannot land a month on the wrong man.
--   * Only the guards IN the file are touched. A guard left out keeps every mark
--     he has. A short file cannot wipe a client.
--   * Only the days that DIFFER are written. A day the sheet agrees with is left
--     alone, so its original row — who marked it, from where — survives, and a
--     verified half-month refuses the import only where the sheet disagrees
--     with what was verified.
--   * Every lock on attendance_records still runs. The rows go in through the
--     table, so the HR-verified half, the OPS-verified month, the cleared-guard
--     lock, the service window, one-status-per-day and the double-duty rules
--     all refuse exactly as they would by hand. The one lock it passes is the
--     confirmed-and-month-ended lock, and only the way the Monthly Board passes
--     it: a replaced or removed mark is cleared the way clear_attendance_day
--     clears one (app.attendance_clear, transaction-local, switched on around
--     that one delete and off again, with an attendance_overrides row saying
--     before → after and why), and the new mark is written with
--     supervisor_override and the import's reason, as the board's Override
--     writes one. A month imported after it ended is late entry by definition.
--   * A guard who already has a payslip for the month is refused. Attendance
--     under a computed payslip would leave the payslip saying one thing and the
--     days another.
--   * A field-app mark (made on site by a supervisor) is not replaced unless the
--     caller says so in as many words (p_replace_app_marks).
--   * The dry run is the real run rolled back, guard by guard, so it reports
--     every trigger's refusal, not a guess at them. The real run is all or
--     nothing: one refused guard and nothing is written.
--   * Every mark written carries import_id. attendance_imports keeps who, when,
--     the file's name and SHA-256, the reason, the counts, and the rows it
--     replaced, so undo_attendance_import() can put the month back. Undo is
--     latest-first per client and month, and it removes any mark the import
--     wrote even if someone edited it since — the undo screen says so.
--
-- DECIDED (set operation, per CLAUDE.md): import_attendance_month writes a set
-- of rows chosen by the file, behind a permission boundary, so it stays
-- SECURITY DEFINER with the boundary asserted inside (require_perm, company,
-- region). Converting it to invoker would turn a refusal into a silently
-- smaller import.

-- ───────────────────────── The record of each import ─────────────────────────
create table public.attendance_imports (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id),
  client_id           uuid not null references public.clients(id),
  period_month        date not null check (period_month = date_trunc('month', period_month)::date),
  file_name           text,
  file_sha256         text,
  note                text not null check (length(btrim(note)) >= 5),
  guards              int not null default 0,
  marks_added         int not null default 0,
  marks_changed       int not null default 0,
  marks_removed       int not null default 0,
  app_marks_replaced  int not null default 0,
  replaced_snapshot   jsonb not null default '[]'::jsonb,
  summary             jsonb not null default '[]'::jsonb,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  undone_at           timestamptz,
  undone_by           uuid,
  undo_reason         text
);
create index attendance_imports_client_month_idx on public.attendance_imports (client_id, period_month, created_at desc);
comment on table public.attendance_imports is
  '0638 (3 Nov 2026): one row per month of attendance imported from the Excel template — who, when, the file and its SHA-256, the reason, the counts, and the attendance rows it replaced (replaced_snapshot) so undo_attendance_import can restore them. Written only by import_attendance_month / undo_attendance_import. Read with attendance.import or attendance.view.';
alter table public.attendance_imports enable row level security;
create policy company_members on public.attendance_imports for select
  using (company_id = (select public.current_company_id()));
create policy ssa_all on public.attendance_imports for select
  using ((select public.is_ssa_unscoped()));
create policy perm_read on public.attendance_imports as restrictive for select
  using ((select public.has_perm('attendance.import')) or (select public.has_perm('attendance.view')));
revoke insert, update, delete on public.attendance_imports from anon, authenticated;
grant select on public.attendance_imports to authenticated;

alter table public.attendance_records add column import_id uuid references public.attendance_imports(id) on delete set null;
create index attendance_records_import_idx on public.attendance_records (import_id) where import_id is not null;
comment on column public.attendance_records.import_id is
  '0638: the attendance_imports row that wrote this mark, if it came from an imported sheet. Null for every mark made on a screen or in the field app.';

insert into public.permission_keys (key, grp, label)
values ('attendance.import', 'Attendance', 'Import a month of attendance from the Excel sheet (replaces the differing days for the guards in the file)')
on conflict (key) do nothing;

-- ───────────────────────── One guard's month (private) ─────────────────────────
-- Not callable by a login: import_attendance_month asserts the boundary and
-- calls this once per guard.
create or replace function public._attendance_import_guard(
  p_import uuid, p_client uuid, p_emp uuid, p_month date, p_marks jsonb, p_note text, p_replace_app boolean)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  e        record;
  o        record;
  d        date;
  v_last   date := (p_month + interval '1 month - 1 day')::date;
  v_code   text;
  v_new    text;
  v_site   uuid;
  v_shift  text;
  v_added  int := 0; v_changed int := 0; v_removed int := 0; v_same int := 0; v_app int := 0;
  v_snap   jsonb := '[]'::jsonb;
begin
  select id, company_id, shift into e from public.employees where id = p_emp;

  for d in select generate_series(p_month, v_last, interval '1 day')::date loop
    v_code := upper(btrim(coalesce(p_marks ->> extract(day from d)::int::text, '')));
    v_new := case v_code when 'P' then 'present' when 'L' then 'leave' when 'A' then 'absent' when 'R' then 'rest_day' else null end;

    select count(*) as n, min(a.status) as status, coalesce(bool_or(a.source = 'app'), false) as app,
           min(a.site_id::text)::uuid as site_id, min(a.worked_shift) as shift
      into o
      from public.attendance_records a
     where a.employee_id = p_emp and a.attendance_date = d
       and (a.worked_for_client_id = p_client or a.worked_for_client_id is null);

    if o.n = 0 and v_new is null then continue; end if;
    if o.n = 1 and o.status = v_new then v_same := v_same + 1; continue; end if;

    if o.app and not p_replace_app then
      raise exception '% has a mark from the field app (made on site). Tick "replace field-app marks" to overwrite it.', to_char(d, 'DD Mon');
    end if;

    if o.n > 0 then
      select v_snap || coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) into v_snap
        from public.attendance_records a
       where a.employee_id = p_emp and a.attendance_date = d
         and (a.worked_for_client_id = p_client or a.worked_for_client_id is null);
      -- Cleared the way clear_attendance_day clears a mark: logged, then the
      -- confirmed-month lock switched off for this one delete only.
      insert into public.attendance_overrides
        (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
      select e.company_id, p_client, null, p_emp, d, 'Imported: ' || p_note, a.status, coalesce(v_new, 'cleared'), auth.uid()
        from public.attendance_records a
       where a.employee_id = p_emp and a.attendance_date = d
         and (a.worked_for_client_id = p_client or a.worked_for_client_id is null);
      perform set_config('app.attendance_clear', 'on', true);
      delete from public.attendance_records a
       where a.employee_id = p_emp and a.attendance_date = d
         and (a.worked_for_client_id = p_client or a.worked_for_client_id is null);
      perform set_config('app.attendance_clear', '', true);
      if o.app then v_app := v_app + 1; end if;
    end if;

    if v_new is null then
      v_removed := v_removed + 1;
      continue;
    end if;
    if o.n > 0 then v_changed := v_changed + 1; else v_added := v_added + 1; end if;

    -- The site and shift the guard was on: the row being replaced, else his
    -- latest mark at this client this month, else his deployment that day.
    v_site := o.site_id;
    v_shift := o.shift;
    if v_site is null then
      select a.site_id, coalesce(v_shift, a.worked_shift) into v_site, v_shift
        from public.attendance_records a
       where a.employee_id = p_emp and a.worked_for_client_id = p_client
         and a.attendance_date between p_month and v_last and a.site_id is not null
       order by a.attendance_date desc limit 1;
    end if;
    if v_site is null then
      select dp.site_id into v_site from public.deployments dp
       where dp.guard_id = p_emp and dp.client_id = p_client and dp.start_date <= d
         and (dp.end_date is null or dp.end_date >= d)
       order by dp.start_date desc limit 1;
    end if;
    v_shift := coalesce(v_shift, e.shift, 'day');

    insert into public.attendance_records
      (company_id, employee_id, attendance_date, status, worked_for_client_id, site_id,
       worked_shift, scheduled_shift, source, supervisor_override, override_reason,
       backfill_reason, backfilled_by, import_id)
    values
      (e.company_id, p_emp, d, v_new, p_client, v_site,
       v_shift, v_shift, 'manual', true, 'Imported: ' || p_note,
       'Imported: ' || p_note, auth.uid(), p_import);
  end loop;

  return jsonb_build_object('added', v_added, 'changed', v_changed, 'removed', v_removed,
                            'same', v_same, 'app_replaced', v_app, 'snapshot', v_snap);
end
$fn$;
revoke all on function public._attendance_import_guard(uuid, uuid, uuid, date, jsonb, text, boolean) from public, anon, authenticated;
comment on function public._attendance_import_guard(uuid, uuid, uuid, date, jsonb, text, boolean) is
  '0638: writes one guard''s month from an imported sheet — only the days that differ, through every trigger on attendance_records. Not callable by a login; import_attendance_month asserts the boundary first.';

-- ───────────────────────── The import ─────────────────────────
create or replace function public.import_attendance_month(
  p_client_id uuid, p_month date, p_rows jsonb,
  p_file_name text default null, p_file_sha256 text default null, p_note text default null,
  p_preview boolean default true, p_replace_app_marks boolean default false)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  v_co     uuid;
  v_last   date;
  v_days   int;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_import uuid;
  v_seen   uuid[] := '{}';
  r        jsonb;
  k        text;
  v_val    text;
  v_emp    uuid;
  e        record;
  v_res    jsonb;
  v_err    text;
  v_out    jsonb := '[]'::jsonb;
  v_snap   jsonb := '[]'::jsonb;
  v_dup    uuid;
  t_added int := 0; t_changed int := 0; t_removed int := 0; t_same int := 0; t_app int := 0; t_err int := 0; t_n int := 0;
begin
  -- THE BOUNDARY COMES FIRST: key, company, region.
  perform public.require_perm('attendance.import');
  -- tenant guard [resolved]: owning company looked up from p_client_id via public.clients
  perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  perform public.assert_branch_writable((select branch_id from public.clients where id = p_client_id));

  select company_id into v_co from public.clients where id = p_client_id;
  if v_co is null then raise exception 'That client does not exist.'; end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception 'The month must be given as its first day, e.g. 2026-10-01.';
  end if;
  if p_month > date_trunc('month', current_date)::date then
    raise exception 'Attendance cannot be imported for a month that has not started.';
  end if;
  v_last := (p_month + interval '1 month - 1 day')::date;
  v_days := extract(day from v_last)::int;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The file has no guards in it.';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'One import takes at most 1,000 guards.';
  end if;
  if not p_preview and (v_note is null or length(v_note) < 5) then
    raise exception 'Say why this month is being imported — it is kept on every mark the import writes.';
  end if;

  if not p_preview then
    insert into public.attendance_imports (company_id, client_id, period_month, file_name, file_sha256, note)
    values (v_co, p_client_id, p_month, nullif(btrim(coalesce(p_file_name, '')), ''), p_file_sha256, v_note)
    returning id into v_import;
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    v_err := null; v_res := null; t_n := t_n + 1;

    -- The file's shape. These refuse the whole file, dry run included: a
    -- malformed file is not a per-guard problem.
    begin
      v_emp := (r ->> 'employee_id')::uuid;
    exception when others then
      raise exception 'Row % of the file has no valid guard.', t_n;
    end;
    select id, company_id, client_id, category, full_name, guard_code into e from public.employees where id = v_emp;
    if e.id is null or e.company_id <> v_co then
      raise exception 'Row % of the file names a guard who is not in this company.', t_n;
    end if;
    if v_emp = any(v_seen) then
      raise exception '% (%) is in the file twice.', e.full_name, e.guard_code;
    end if;
    v_seen := v_seen || v_emp;
    if jsonb_typeof(r -> 'marks') is distinct from 'object' then
      raise exception '% (%): no days given.', e.full_name, e.guard_code;
    end if;
    for k, v_val in select key, value #>> '{}' from jsonb_each(r -> 'marks') loop
      if k !~ '^\d{1,2}$' or k::int < 1 or k::int > v_days then
        raise exception '% (%): "%" is not a day of %.', e.full_name, e.guard_code, k, to_char(p_month, 'FMMonth YYYY');
      end if;
      if upper(btrim(coalesce(v_val, ''))) not in ('P', 'L', 'A', 'R', '') then
        raise exception '% (%): day % says "%". Use P, L, A, R, or leave it blank.', e.full_name, e.guard_code, k, v_val;
      end if;
      if btrim(coalesce(v_val, '')) <> '' and (p_month + (k::int - 1)) > current_date then
        raise exception '% (%): day % is in the future.', e.full_name, e.guard_code, k;
      end if;
    end loop;

    -- Per-guard refusals. Collected in the dry run; fatal in the real one.
    if e.client_id is distinct from p_client_id and e.category <> 'reliever' then
      v_err := 'is not on this client. Move him in Employees first, or import him under his own client.';
    elsif exists (select 1 from public.payslips ps where ps.employee_id = v_emp and ps.period_month = p_month) then
      v_err := 'already has a payslip for ' || to_char(p_month, 'FMMonth YYYY') || '. Attendance under a payslip is not replaced by an import.';
    end if;

    if p_preview then
      if v_err is null then
        begin
          v_res := public._attendance_import_guard(null, p_client_id, v_emp, p_month, r -> 'marks', coalesce(v_note, 'dry run'), p_replace_app_marks);
          raise exception using errcode = 'P0V01', message = 'dry run';
        exception
          when sqlstate 'P0V01' then null;
          when others then get stacked diagnostics v_err = message_text; v_res := null;
        end;
      end if;
    else
      if v_err is not null then
        raise exception '% (%) %', e.full_name, e.guard_code, v_err;
      end if;
      begin
        v_res := public._attendance_import_guard(v_import, p_client_id, v_emp, p_month, r -> 'marks', v_note, p_replace_app_marks);
      exception when others then
        get stacked diagnostics v_err = message_text;
        raise exception '% (%): %. Nothing was imported.', e.full_name, e.guard_code, v_err;
      end;
      v_snap := v_snap || (v_res -> 'snapshot');
    end if;

    if v_err is not null then t_err := t_err + 1; end if;
    t_added   := t_added   + coalesce((v_res ->> 'added')::int, 0);
    t_changed := t_changed + coalesce((v_res ->> 'changed')::int, 0);
    t_removed := t_removed + coalesce((v_res ->> 'removed')::int, 0);
    t_same    := t_same    + coalesce((v_res ->> 'same')::int, 0);
    t_app     := t_app     + coalesce((v_res ->> 'app_replaced')::int, 0);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'employee_id', v_emp, 'name', e.full_name, 'code', e.guard_code,
      'added', (v_res ->> 'added')::int, 'changed', (v_res ->> 'changed')::int,
      'removed', (v_res ->> 'removed')::int, 'same', (v_res ->> 'same')::int,
      'app_replaced', (v_res ->> 'app_replaced')::int, 'error', v_err));
  end loop;

  if p_file_sha256 is not null then
    select id into v_dup from public.attendance_imports
     where client_id = p_client_id and period_month = p_month and file_sha256 = p_file_sha256
       and undone_at is null and id is distinct from v_import
     limit 1;
  end if;

  if not p_preview then
    update public.attendance_imports
       set guards = t_n, marks_added = t_added, marks_changed = t_changed, marks_removed = t_removed,
           app_marks_replaced = t_app, replaced_snapshot = v_snap, summary = v_out
     where id = v_import;
  end if;

  return jsonb_build_object(
    'preview', p_preview, 'import_id', v_import, 'guards', v_out,
    'totals', jsonb_build_object('guards', t_n, 'added', t_added, 'changed', t_changed, 'removed', t_removed,
                                 'same', t_same, 'app_replaced', t_app, 'refused', t_err),
    'same_file_imported_before', v_dup is not null);
end
$fn$;
revoke all on function public.import_attendance_month(uuid, date, jsonb, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.import_attendance_month(uuid, date, jsonb, text, text, text, boolean, boolean) to authenticated;
comment on function public.import_attendance_month(uuid, date, jsonb, text, text, text, boolean, boolean) is
  '0638: imports a month of attendance for one client from the Excel template. p_rows = [{employee_id, marks: {"1":"P", …}}] with P present, L leave, A absent, R rest day, blank none. Dry run by default (the real run rolled back guard by guard, so every lock reports); the real run is all or nothing and records an attendance_imports row. Writes only the days that differ, only for the guards in the file. DECIDED: stays SECURITY DEFINER — a set operation behind a permission boundary (CLAUDE.md).';

-- ───────────────────────── Undo ─────────────────────────
create or replace function public.undo_attendance_import(p_import_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare
  imp    record;
  v_del  int;
  v_ins  int := 0;
  r      jsonb;
begin
  perform public.require_perm('attendance.import');
  -- tenant guard [resolved]: owning company looked up from p_import_id via public.attendance_imports
  perform public.assert_same_company((select company_id from public.attendance_imports where id = p_import_id));
  perform public.assert_branch_writable((select c.branch_id from public.attendance_imports i join public.clients c on c.id = i.client_id where i.id = p_import_id));

  select * into imp from public.attendance_imports where id = p_import_id for update;
  if imp.id is null then raise exception 'That import does not exist.'; end if;
  if imp.undone_at is not null then
    raise exception 'That import was already undone on %.', to_char(imp.undone_at, 'DD Mon YYYY');
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why the import is being undone.';
  end if;
  if exists (select 1 from public.attendance_imports x
              where x.client_id = imp.client_id and x.period_month = imp.period_month
                and x.undone_at is null and x.created_at > imp.created_at) then
    raise exception 'A later import for the same client and month is still in place. Undo that one first.';
  end if;

  -- Logged in attendance_overrides like any cleared mark, with the confirmed-
  -- month lock off for these writes only. Every other lock still applies.
  insert into public.attendance_overrides
    (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
  select a.company_id, imp.client_id, null, a.employee_id, a.attendance_date, 'Import undone: ' || btrim(p_reason), a.status, 'cleared', auth.uid()
    from public.attendance_records a where a.import_id = p_import_id;
  perform set_config('app.attendance_clear', 'on', true);
  delete from public.attendance_records where import_id = p_import_id;
  get diagnostics v_del = row_count;

  for r in select value from jsonb_array_elements(imp.replaced_snapshot) loop
    insert into public.attendance_records select * from jsonb_populate_record(null::public.attendance_records, r);
    insert into public.attendance_overrides
      (company_id, client_id, category, employee_id, attendance_date, reason, before_value, after_value, created_by)
    values ((r ->> 'company_id')::uuid, imp.client_id, null, (r ->> 'employee_id')::uuid, (r ->> 'attendance_date')::date,
            'Import undone: ' || btrim(p_reason), 'cleared', r ->> 'status', auth.uid());
    v_ins := v_ins + 1;
  end loop;
  perform set_config('app.attendance_clear', '', true);

  update public.attendance_imports
     set undone_at = now(), undone_by = auth.uid(), undo_reason = btrim(p_reason)
   where id = p_import_id;

  return jsonb_build_object('removed', v_del, 'restored', v_ins);
end
$fn$;
revoke all on function public.undo_attendance_import(uuid, text) from public, anon;
grant execute on function public.undo_attendance_import(uuid, text) to authenticated;
comment on function public.undo_attendance_import(uuid, text) is
  '0638: puts a month back as it was before an import — removes every mark the import wrote (even one edited since) and restores the rows it replaced. Latest import first, per client and month. Every attendance lock still applies to the restore.';

-- ───────────────────────── Tests (rolled back) ─────────────────────────
-- On 68 HS-PCI-PFM, October 2026, guard Khuda Yar (GGS-00635): present 1–20 in
-- Bastion (WhatsApp, confirmed, the month ended), no payslip for October. The
-- first half's verification row exists but is unsigned; test 2 signs it.
do $test$
declare
  v_boss   constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr     constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_client constant uuid := 'c528cb54-89b2-4ec3-b62c-0833fb1a9033';
  v_guard  uuid;
  v_other  uuid;
  v_marks  jsonb;
  v_res    jsonb;
  v_imp    uuid;
  v_msg    text;
  v_n      int;
  v_ran    int := 0;
  d        int;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select id into v_guard from public.employees where guard_code = 'GGS-00635';
    select id into v_other from public.employees
     where company_id = public.current_company_id() and lifecycle_state = 'active' and category = 'client'
       and client_id <> v_client limit 1;

    -- The month as Bastion has it, 21–31 present on top.
    v_marks := '{}'::jsonb;
    for d in 1..31 loop v_marks := v_marks || jsonb_build_object(d::text, 'P'); end loop;

    -- 1. A dry run reports 11 added, 20 the same, and writes nothing.
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks)));
    if (v_res #>> '{totals,added}')::int <> 11 or (v_res #>> '{totals,same}')::int <> 20 or (v_res #>> '{totals,refused}')::int <> 0 then
      raise exception '0638 REFUSED: dry run reported %.', v_res -> 'totals';
    end if;
    select count(*) into v_n from public.attendance_records where employee_id = v_guard and attendance_date between '2026-10-01' and '2026-10-31';
    if v_n <> 20 then raise exception '0638 REFUSED: the dry run wrote (% marks, expected 20).', v_n; end if;
    v_ran := v_ran + 1;

    -- 2. Once HR signs the first half, a day there that differs is refused with the half lock's own words.
    update public.attendance_half_verifications set hr_verified_at = now(), hr_verified_by = v_boss
     where client_id = v_client and period_month = '2026-10-01' and half = 1;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '0638 REFUSED: expected one first-half verification row to sign, found %.', v_n; end if;
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks || '{"2":"L"}'::jsonb)));
    if (v_res #>> '{totals,refused}')::int <> 1 or (v_res #>> '{guards,0,error}') not like '%HR has verified%' then
      raise exception '0638 REFUSED: a change inside a verified half was not refused by the half lock (%).', v_res #>> '{guards,0,error}';
    end if;
    update public.attendance_half_verifications set hr_verified_at = null, hr_verified_by = null
     where client_id = v_client and period_month = '2026-10-01' and half = 1;
    v_ran := v_ran + 1;

    -- 3. The real run needs a reason.
    v_msg := null;
    begin perform public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks)), 'test.xlsx', 'abc', null, false);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'Say why this month is being imported%' then raise exception '0638 REFUSED: an import with no reason ran (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 4. The real run adds the 11 and changes the 17th (a confirmed day, month
    --    ended) to leave: tagged, logged in attendance_overrides, and recorded.
    v_marks := v_marks || '{"17":"L"}'::jsonb;
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks)), 'test.xlsx', 'abc', 'HRO confirmed sheet', false);
    v_imp := (v_res ->> 'import_id')::uuid;
    select count(*) into v_n from public.attendance_records where import_id = v_imp and supervisor_override and worked_for_client_id = v_client;
    if v_n <> 12 then raise exception '0638 REFUSED: the import wrote % tagged marks, expected 12.', v_n; end if;
    if (select status from public.attendance_records where employee_id = v_guard and attendance_date = '2026-10-17') is distinct from 'leave' then
      raise exception '0638 REFUSED: the 17th was not changed to leave.';
    end if;
    if not exists (select 1 from public.attendance_overrides where employee_id = v_guard and attendance_date = '2026-10-17'
                    and before_value = 'present' and after_value = 'leave' and reason = 'Imported: HRO confirmed sheet') then
      raise exception '0638 REFUSED: the changed day was not logged in attendance_overrides.';
    end if;
    if coalesce(current_setting('app.attendance_clear', true), '') = 'on' then
      raise exception '0638 REFUSED: the confirmed-month switch was left on after the import.';
    end if;
    select count(*) into v_n from public.attendance_records where employee_id = v_guard and attendance_date between '2026-10-01' and '2026-10-31';
    if v_n <> 31 then raise exception '0638 REFUSED: the guard has % marks after the import, expected 31.', v_n; end if;
    if not exists (select 1 from public.attendance_imports where id = v_imp and marks_added = 11 and marks_changed = 1 and guards = 1
                    and file_sha256 = 'abc' and jsonb_array_length(replaced_snapshot) = 1) then
      raise exception '0638 REFUSED: the import record is missing or wrong.';
    end if;
    v_ran := v_ran + 1;

    -- 5. The same file again is flagged, and changes nothing.
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks)), 'test.xlsx', 'abc');
    if not (v_res ->> 'same_file_imported_before')::boolean or (v_res #>> '{totals,same}')::int <> 31 then
      raise exception '0638 REFUSED: a repeat of the same file was not recognised (%).', v_res;
    end if;
    v_ran := v_ran + 1;

    -- 6. A field-app mark is not replaced unless asked.
    update public.attendance_records set source = 'app' where employee_id = v_guard and attendance_date = '2026-10-25';
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks || '{"25":"L"}'::jsonb)));
    if (v_res #>> '{guards,0,error}') not like '%field app%' then
      raise exception '0638 REFUSED: a field-app mark would have been replaced silently (%).', v_res #>> '{guards,0,error}';
    end if;
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks || '{"25":"L"}'::jsonb)), null, null, null, true, true);
    if (v_res #>> '{totals,changed}')::int <> 1 or (v_res #>> '{totals,app_replaced}')::int <> 1 then
      raise exception '0638 REFUSED: replacing a field-app mark when asked did not report it (%).', v_res -> 'totals';
    end if;
    update public.attendance_records set source = 'manual' where employee_id = v_guard and attendance_date = '2026-10-25';
    v_ran := v_ran + 1;

    -- 7. Undo puts the month back to the 20 it had, the 17th present again.
    v_res := public.undo_attendance_import(v_imp, 'test');
    select count(*) into v_n from public.attendance_records where employee_id = v_guard and attendance_date between '2026-10-01' and '2026-10-31';
    if v_n <> 20 or (v_res ->> 'removed')::int <> 12 or (v_res ->> 'restored')::int <> 1 then
      raise exception '0638 REFUSED: undo left % marks (expected 20), removed % (12), restored % (1).', v_n, v_res ->> 'removed', v_res ->> 'restored';
    end if;
    if (select status from public.attendance_records where employee_id = v_guard and attendance_date = '2026-10-17') is distinct from 'present' then
      raise exception '0638 REFUSED: undo did not restore the 17th to present.';
    end if;
    v_msg := null;
    begin perform public.undo_attendance_import(v_imp, 'again'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'That import was already undone%' then raise exception '0638 REFUSED: an import could be undone twice (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 8. A guard on another client, a guard twice, a bad code and a future day are refused.
    v_res := public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_other, 'marks', '{"21":"P"}'::jsonb)));
    if (v_res #>> '{guards,0,error}') not like 'is not on this client%' then raise exception '0638 REFUSED: a guard from another client was accepted (%).', v_res #>> '{guards,0,error}'; end if;
    v_msg := null;
    begin perform public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks), jsonb_build_object('employee_id', v_guard, 'marks', v_marks)));
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%is in the file twice.' then raise exception '0638 REFUSED: a guard twice was accepted (%).', coalesce(v_msg, 'no error'); end if;
    v_msg := null;
    begin perform public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', '{"21":"X"}'::jsonb)));
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%day 21 says "X". Use P, L, A, R, or leave it blank.' then raise exception '0638 REFUSED: a bad code was accepted (%).', coalesce(v_msg, 'no error'); end if;
    v_msg := null;
    begin perform public.import_attendance_month(v_client, date_trunc('month', current_date)::date, jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', jsonb_build_object(extract(day from (date_trunc('month', current_date) + interval '1 month - 1 day'))::int::text, 'P'))));
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like '%is in the future.' then raise exception '0638 REFUSED: a future day was accepted (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 9. A login without attendance.import is refused, dry run included, and cannot write the record table.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['attendance.view', 'attendance.edit', 'attendance.backdate'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null;
    begin perform public.import_attendance_month(v_client, '2026-10-01', jsonb_build_array(jsonb_build_object('employee_id', v_guard, 'marks', v_marks)));
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'permission denied: attendance.import required' then raise exception '0638 REFUSED: a login without the key ran an import (%).', coalesce(v_msg, 'no error'); end if;
    execute 'set local role authenticated';
    v_msg := null;
    begin insert into public.attendance_imports (company_id, client_id, period_month, note) values (public.current_company_id(), v_client, '2026-10-01', 'forged import');
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'permission denied for table attendance_imports%' then raise exception '0638 REFUSED: a login wrote the import record directly (%).', coalesce(v_msg, 'no error'); end if;
    v_msg := null;
    begin perform public._attendance_import_guard(null, v_client, v_guard, '2026-10-01', v_marks, 'x', false);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'permission denied for function _attendance_import_guard%' then raise exception '0638 REFUSED: a login called the private per-guard writer (%).', coalesce(v_msg, 'no error'); end if;
    execute 'reset role';
    v_ran := v_ran + 1;

    if v_ran <> 9 then raise exception '0638 REFUSED: % of 9 assertions ran.', v_ran; end if;
    raise exception '0638-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0638-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0638 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0638 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() g where g.function_name in ('import_attendance_month', 'undo_attendance_import', '_attendance_import_guard')) then
    raise exception '0638 REFUSED: branch_guard_gaps() reports the import functions.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0638 REFUSED: permission_key_gaps() reports a demanded key the grant screen cannot offer.'; end if;
end $test$;
