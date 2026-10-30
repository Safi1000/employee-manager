-- 0617 — warnings: soft and formal, raised in the field, approved in the office
--
-- DECIDED by Shayan, 30 Oct 2026:
--   * SOFT warnings: as many as needed. A history to follow — no fine, no count.
--   * FORMAL warnings: 3 allowed in 12 months. The 3rd inside a rolling 12
--     months is followed by termination.
--   * A fine is 1–6 days' salary, and the number of days is set by HR ONLY. The
--     supervisor reports; he never proposes days, and the app shows none.
--   * The 3rd formal warning FLAGS the guard for termination review and alerts.
--     HR separates him through the normal Fire flow, so dues and clearance run as
--     they always do. Nothing here separates anyone.
--   * An approved fine WAITS on Payroll ("fines from warnings" for that month);
--     HR presses Add and it goes through the existing fine-by-days path on the
--     payslip. Nothing here moves money or touches a payslip.
--   * The approver is whoever holds a permission, never a named person
--     (Shayan: "don't link anything with any specific user").
--
-- Two DIFFERENT people act — the supervisor raises, the office approves — so the
-- approval key follows the stage, not the table (the transition_record_state
-- rule in CLAUDE.md): warnings.approve, new, in PERMISSION_GROUPS and
-- permission_keys. Before 0617 any company login could insert a warning; now a
-- FORMAL approved warning, or a fine, needs warnings.approve at the moment it is
-- written. Soft warnings stay open to any login of the company, as before.
--
-- disciplinary_warnings (0 rows on 30 Oct) gains kind, status, source, site_id,
-- raised_by_name, fine_days, the decision, and when the fine reached payroll.
-- warning_number now means "which formal warning in the 12 months before this
-- one": null for soft, pending and refused warnings.
--
-- The two trigger functions from 0084 have exactly one author, so they are
-- restated — behind a digest precondition that refuses any body it does not
-- recognise (CLAUDE.md: "edited by exactly one → may be restated").
-- assign_warning_and_escalate now runs on insert AND update, so a warning is
-- numbered when it is APPROVED, not when it is raised.
--
-- A 12-month window rolls without anything being written, so a guard's flag can
-- go stale with no trigger to clear it: refresh_warning_windows() recomputes
-- every flagged guard daily (cron 'warning-window-refresh', 00:30 Pakistan).
--
--   field_raise_warning(site, guard, kind, reason)   supervisor / field.app
--   field_guard_warnings(site, guard)                the guard's history, no fine
--   decide_warning(id, approve, fine_days, note)     warnings.approve
--   mark_warning_fine_applied(id)                    payroll.edit / payroll.adjust
--
-- Asserted under a sentinel: a soft warning from the phone is recorded and not
-- counted; a formal one waits unnumbered; approving it with 4 days numbers it 1;
-- a refused one stays unnumbered; the 3rd approved formal flags the guard and
-- alerts; one older than 12 months is not counted; the phone's history carries no
-- fine; a fine without the permission, a 7-day fine, a fine on a soft warning and
-- deciding twice are refused by message.

-- -------------------------------------------------------------- columns
alter table public.disciplinary_warnings alter column warning_number drop not null;
alter table public.disciplinary_warnings drop constraint if exists warning_number_range;
alter table public.disciplinary_warnings add constraint warning_number_range check (warning_number is null or warning_number between 1 and 3);
alter table public.disciplinary_warnings add column if not exists kind text not null default 'formal' check (kind in ('soft', 'formal'));
alter table public.disciplinary_warnings add column if not exists status text not null default 'approved' check (status in ('pending', 'approved', 'refused'));
alter table public.disciplinary_warnings add column if not exists source text not null default 'web' check (source in ('web', 'app'));
alter table public.disciplinary_warnings add column if not exists site_id uuid references public.sites (id);
alter table public.disciplinary_warnings add column if not exists raised_by_name text;
alter table public.disciplinary_warnings add column if not exists fine_days smallint check (fine_days between 1 and 6);
alter table public.disciplinary_warnings add column if not exists decided_by uuid references public.profiles (id);
alter table public.disciplinary_warnings add column if not exists decided_at timestamptz;
alter table public.disciplinary_warnings add column if not exists decision_note text;
alter table public.disciplinary_warnings add column if not exists fine_applied_at timestamptz;
alter table public.disciplinary_warnings add column if not exists fine_applied_by uuid references public.profiles (id);
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'warning_fine_is_formal') then
    alter table public.disciplinary_warnings add constraint warning_fine_is_formal check (fine_days is null or (kind = 'formal' and status = 'approved'));
  end if;
end $c$;
comment on table public.disciplinary_warnings is
  '0084/0617. DECIDED 30 Oct 2026: soft warnings unlimited, history only (no fine, no count). Formal: 3 per rolling 12 months; the 3rd flags termination review (HR separates via Fire). Fine 1–6 days'' salary set by HR only (warnings.approve); it waits on Payroll until HR adds it (fine_applied_at). warning_number = which formal warning in the 12 months; null unless formal and approved.';

-- -------------------------------------------------------------- the two trigger functions (one author: 0084)
do $pre$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.assign_warning_and_escalate()'::regprocedure) not in
       ('88fcedbafbbe4d445fc33f2ed28bb10f') and position('-- 0617.' in (select prosrc from pg_proc where oid = 'public.assign_warning_and_escalate()'::regprocedure)) = 0 then
    raise exception '0617 REFUSED: assign_warning_and_escalate is not the 0084 body this file replaces.';
  end if;
  if (select md5(prosrc) from pg_proc where oid = 'public.refresh_termination_review()'::regprocedure) not in
       ('67e6bc9360bb733731b9d88c67fd60a2') and position('-- 0617.' in (select prosrc from pg_proc where oid = 'public.refresh_termination_review()'::regprocedure)) = 0 then
    raise exception '0617 REFUSED: refresh_termination_review is not the 0084 body this file replaces.';
  end if;
end $pre$;

create or replace function public.formal_warnings_in_window(p_employee_id uuid, p_on date)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  -- 0617. Approved, unrescinded formal warnings in the 12 months up to p_on.
  -- tenant guard [exempt]: internal, revoked from every API role; callers pass their own row's employee.
  select count(*)::int from public.disciplinary_warnings
   where employee_id = p_employee_id and kind = 'formal' and status = 'approved' and not rescinded
     and issued_on > (p_on - interval '12 months')::date and issued_on <= p_on;
$$;
comment on function public.formal_warnings_in_window(uuid, date) is
  'TENANT GUARD EXEMPT: internal (0617) — approved formal warnings in the rolling 12 months up to a date.';
revoke all on function public.formal_warnings_in_window(uuid, date) from public, anon, authenticated;

create or replace function public.assign_warning_and_escalate()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
-- 0617. Numbers a FORMAL warning when it is approved; guards who may approve or fine.
begin
  if new.kind = 'formal' and new.status = 'approved' and not new.rescinded then
    if tg_op = 'INSERT' or old.status is distinct from 'approved' or old.kind is distinct from 'formal' then
      -- written as approved now: the approval stage, which needs warnings.approve
      if pg_trigger_depth() <= 1 and not public.has_perm('warnings.approve') then
        raise exception 'Approving a formal warning needs the "Approve warnings" permission.' using errcode = '42501';
      end if;
      new.warning_number := least(public.formal_warnings_in_window(new.employee_id, new.issued_on) + 1, 3);
    end if;
  elsif new.kind <> 'formal' or new.status <> 'approved' then
    new.warning_number := null;
  end if;
  if new.fine_days is not null and (tg_op = 'INSERT' or old.fine_days is distinct from new.fine_days)
     and pg_trigger_depth() <= 1 and not public.has_perm('warnings.approve') then
    raise exception 'Setting a fine needs the "Approve warnings" permission.' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function public.refresh_termination_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
-- 0617. Termination review = 3 approved formal warnings in the rolling 12 months; alerts when it turns on.
declare
  v_emp uuid := coalesce(new.employee_id, old.employee_id);
  v_on boolean;
  v_was boolean;
  v_e record;
begin
  v_on := public.formal_warnings_in_window(v_emp, (now() at time zone 'Asia/Karachi')::date) >= 3;
  select pending_termination_review, full_name, employee_code, company_id into v_e from public.employees where id = v_emp;
  v_was := coalesce(v_e.pending_termination_review, false);
  if v_was is distinct from v_on then
    update public.employees set pending_termination_review = v_on, updated_at = now() where id = v_emp;
  end if;
  if v_on and not v_was then
    perform public.raise_alert(v_e.company_id, 'warning', 'warnings',
      v_e.full_name || ' (' || v_e.employee_code || ') has 3 formal warnings in 12 months and is due for termination review. Separate him through Fire if the office agrees.',
      'employees', v_emp, null);
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_dw_assign_number on public.disciplinary_warnings;
create trigger trg_dw_assign_number before insert or update on public.disciplinary_warnings
  for each row execute function public.assign_warning_and_escalate();

create or replace function public.refresh_warning_windows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0617. Daily: a flag whose 12-month window has rolled past it is cleared.
  -- tenant guard [exempt]: cron only, revoked from every API role; touches each company's own rows.
  declare n int;
  begin
    update public.employees e set pending_termination_review = false, updated_at = now()
     where e.pending_termination_review
       and public.formal_warnings_in_window(e.id, (now() at time zone 'Asia/Karachi')::date) < 3
       and exists (select 1 from public.disciplinary_warnings w where w.employee_id = e.id);
    get diagnostics n = row_count;
    return n;
  end $$;
comment on function public.refresh_warning_windows() is
  'TENANT GUARD EXEMPT: cron only (0617) — clears termination-review flags whose 12-month window has rolled past.';
revoke all on function public.refresh_warning_windows() from public, anon, authenticated;
do $cron$ begin
  if not exists (select 1 from cron.job where jobname = 'warning-window-refresh') then
    perform cron.schedule('warning-window-refresh', '30 19 * * *', 'select public.refresh_warning_windows()');
  end if;
end $cron$;

-- -------------------------------------------------------------- permission
insert into public.permission_keys (key, grp, label) values
  ('warnings.approve', 'Employees', 'Approve or refuse formal warnings and set fines (1–6 days'' salary)')
on conflict (key) do nothing;

-- -------------------------------------------------------------- the phone raises
create or replace function public.field_raise_warning(p_site_id uuid, p_employee_id uuid, p_kind text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
  -- 0617. A soft warning is recorded; a formal one waits for the office (warnings.approve).
  declare v_me record; v_site record; v_e record; v_id uuid;
  begin
    -- tenant guard [resolved]: the site's and the guard's company; then the caller's roster for that site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    perform public.assert_same_company((select e.company_id from public.employees e where e.id = p_employee_id));
    if not exists (select 1 from public.field_site_roster(p_site_id) r where r.employee_id = p_employee_id) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    if p_kind is null or p_kind not in ('soft', 'formal') then raise exception 'Choose a soft or a formal warning.'; end if;
    if nullif(btrim(p_reason), '') is null then raise exception 'Say why.'; end if;
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) as name into v_me from public.profiles p where p.id = auth.uid();
    select s.name into v_site from public.sites s where s.id = p_site_id;
    select full_name, employee_code into v_e from public.employees where id = p_employee_id;
    insert into public.disciplinary_warnings (company_id, employee_id, issued_on, reason, issued_by, kind, status, source, site_id, raised_by_name)
    values (public.current_company_id(), p_employee_id, public.field_today(), btrim(p_reason), v_me.id, p_kind,
            case when p_kind = 'soft' then 'approved' else 'pending' end, 'app', p_site_id, v_me.name)
    returning id into v_id;
    if p_kind = 'formal' then
      perform public.raise_alert(public.current_company_id(), 'warning', 'warnings',
        v_me.name || ' raised a formal warning for ' || v_e.full_name || ' (' || v_e.employee_code || ') at ' || v_site.name
          || '. Approve or refuse it, and set any fine, in Workforce › Warnings.',
        'disciplinary_warnings', v_id, null);
    end if;
    return jsonb_build_object('id', v_id, 'kind', p_kind, 'status', case when p_kind = 'soft' then 'approved' else 'pending' end);
  end $$;
comment on function public.field_raise_warning(uuid, uuid, text, text) is
  '0617: the field app raises a warning for a guard on the caller''s site. Soft: recorded. Formal: pending until someone with warnings.approve decides (and sets any fine). The phone never sets a fine.';

create or replace function public.field_guard_warnings(p_site_id uuid, p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0617. A guard's warnings for the phone: kind, date, reason, status, number. Never the fine.
  begin
    -- tenant guard [resolved]: the site's and the guard's company; then the caller's roster for that site.
    perform public.assert_same_company((select s.company_id from public.sites s where s.id = p_site_id));
    perform public.assert_same_company((select e.company_id from public.employees e where e.id = p_employee_id));
    if not exists (select 1 from public.field_site_roster(p_site_id) r where r.employee_id = p_employee_id) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'formal_in_12_months', public.formal_warnings_in_window(p_employee_id, public.field_today()),
      'warnings', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', w.id, 'kind', w.kind, 'issued_on', w.issued_on, 'reason', w.reason, 'status', w.status,
          'warning_number', w.warning_number, 'rescinded', w.rescinded, 'raised_by_name', w.raised_by_name)
          order by w.issued_on desc, w.created_at desc), '[]'::jsonb)
        from public.disciplinary_warnings w where w.employee_id = p_employee_id));
  end $$;
comment on function public.field_guard_warnings(uuid, uuid) is
  '0617: a guard''s warning history for the field app (no fine — the app shows no amounts).';

-- -------------------------------------------------------------- the office decides
create or replace function public.decide_warning(p_id uuid, p_approve boolean, p_fine_days integer default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0617. Approve (with any fine of 1–6 days) or refuse a pending formal warning.
  declare n int;
  begin
    if not public.has_perm('warnings.approve') then
      raise exception 'Approving a formal warning needs the "Approve warnings" permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the warning's company.
    perform public.assert_same_company((select company_id from public.disciplinary_warnings where id = p_id));
    if p_fine_days is not null and not (p_fine_days between 1 and 6) then raise exception 'A fine is 1 to 6 days'' salary.'; end if;
    if not p_approve and p_fine_days is not null then raise exception 'A refused warning carries no fine.'; end if;
    update public.disciplinary_warnings
       set status = case when p_approve then 'approved' else 'refused' end,
           fine_days = case when p_approve then p_fine_days end,
           decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
     where id = p_id and status = 'pending' and kind = 'formal';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That warning is not waiting for a decision.'; end if;
    update public.alerts set state = 'resolved', acknowledged_by = auth.uid(), acknowledged_at = now()
     where ref_table = 'disciplinary_warnings' and ref_id = p_id and state = 'open';
  end $$;
comment on function public.decide_warning(uuid, boolean, integer, text) is
  '0617: warnings.approve approves (numbering it in the 12-month window, with any 1–6 day fine) or refuses a pending formal warning.';

create or replace function public.mark_warning_fine_applied(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0617. Payroll has put this warning's fine on the payslip.
  declare n int;
  begin
    if not (public.has_perm('payroll.edit') or public.has_perm('payroll.adjust')) then
      raise exception 'Adding a fine to a payslip needs payroll permission.' using errcode = '42501';
    end if;
    -- tenant guard [resolved]: the warning's company.
    perform public.assert_same_company((select company_id from public.disciplinary_warnings where id = p_id));
    update public.disciplinary_warnings set fine_applied_at = now(), fine_applied_by = auth.uid()
     where id = p_id and fine_days is not null and fine_applied_at is null and status = 'approved' and not rescinded;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'That fine is not waiting for payroll.'; end if;
  end $$;
comment on function public.mark_warning_fine_applied(uuid) is
  '0617: Payroll marks a warning''s fine as added to the payslip (the fine itself goes through the existing fine-by-days path).';

revoke all on function public.field_raise_warning(uuid, uuid, text, text) from public, anon;
grant execute on function public.field_raise_warning(uuid, uuid, text, text) to authenticated;
revoke all on function public.field_guard_warnings(uuid, uuid) from public, anon;
grant execute on function public.field_guard_warnings(uuid, uuid) to authenticated;
revoke all on function public.decide_warning(uuid, boolean, integer, text) from public, anon;
grant execute on function public.decide_warning(uuid, boolean, integer, text) to authenticated;
revoke all on function public.mark_warning_fine_applied(uuid) from public, anon;
grant execute on function public.mark_warning_fine_applied(uuid) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('field_raise_warning', null, 'EXEMPT 0617: field_site_roster (the caller''s own sites) checked inside'),
  ('field_guard_warnings', null, 'EXEMPT 0617: field_site_roster (the caller''s own sites) checked inside'),
  ('decide_warning', '{warnings.approve}', '0617: approve / refuse a formal warning'),
  ('mark_warning_fine_applied', '{payroll.edit,payroll.adjust}', '0617: payroll marks a warning fine added')
on conflict (function_name) do nothing;

-- -------------------------------------------------------------- test
do $test$
declare
  v_hr    constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_boss  constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_site  constant uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- 68 HS
  v_guard uuid; v_res jsonb; v_w1 uuid; v_w2 uuid; v_w3 uuid; v_soft uuid; v_old uuid; v_msg text; v_h jsonb;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    select r.employee_id into v_guard from public.field_site_roster(v_site) r order by r.full_name limit 1;
    delete from public.disciplinary_warnings where employee_id = v_guard;
    update public.employees set pending_termination_review = false where id = v_guard;
    update public.profiles set user_type = 'site_supervisor', site_scope = array[v_site] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    -- soft: recorded, not counted; formal: waits, unnumbered
    v_soft := (public.field_raise_warning(v_site, v_guard, 'soft', 'Late') ->> 'id')::uuid;
    v_w1 := (public.field_raise_warning(v_site, v_guard, 'formal', 'Asleep on duty') ->> 'id')::uuid;
    if not exists (select 1 from public.disciplinary_warnings where id = v_soft and status = 'approved' and warning_number is null and source = 'app')
       or not exists (select 1 from public.disciplinary_warnings where id = v_w1 and status = 'pending' and warning_number is null)
       or not exists (select 1 from public.alerts where ref_table = 'disciplinary_warnings' and ref_id = v_w1 and state = 'open') then
      raise exception '0617 REFUSED: soft or pending formal warning recorded wrong.';
    end if;
    v_msg := null; begin perform public.decide_warning(v_w1, true, 4, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Approving a formal warning needs the "Approve warnings" permission.' then raise exception '0617 REFUSED: a supervisor deciding got "%".', v_msg; end if;
    v_h := public.field_guard_warnings(v_site, v_guard);
    if exists (select 1 from jsonb_array_elements(v_h -> 'warnings') x where x ? 'fine_days') then raise exception '0617 REFUSED: the phone''s history carries a fine.'; end if;

    -- the office approves with 4 days: numbered 1, alert resolved
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    perform public.decide_warning(v_w1, true, 4, 'Seen on visit');
    if not exists (select 1 from public.disciplinary_warnings where id = v_w1 and status = 'approved' and warning_number = 1 and fine_days = 4 and decided_by = v_boss)
       or exists (select 1 from public.alerts where ref_table = 'disciplinary_warnings' and ref_id = v_w1 and state = 'open') then
      raise exception '0617 REFUSED: approving did not number it 1 with 4 days, or left the alert open.';
    end if;
    v_msg := null; begin perform public.decide_warning(v_w1, true, 4, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That warning is not waiting for a decision.' then raise exception '0617 REFUSED: deciding twice got "%".', v_msg; end if;
    v_msg := null; begin perform public.decide_warning(v_soft, true, 2, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That warning is not waiting for a decision.' then raise exception '0617 REFUSED: fining a soft warning got "%".', v_msg; end if;

    -- one older than 12 months is not counted; a refused one is not numbered
    insert into public.disciplinary_warnings (employee_id, reason, issued_on, kind, status) values (v_guard, 'Old', (current_date - interval '13 months')::date, 'formal', 'approved') returning id into v_old;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_w2 := (public.field_raise_warning(v_site, v_guard, 'formal', 'Absent from post') ->> 'id')::uuid;
    v_w3 := (public.field_raise_warning(v_site, v_guard, 'formal', 'No uniform') ->> 'id')::uuid;
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.decide_warning(v_w2, true, 7, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'A fine is 1 to 6 days'' salary.' then raise exception '0617 REFUSED: a 7-day fine got "%".', v_msg; end if;
    perform public.decide_warning(v_w2, false, null, 'Not proven');
    if exists (select 1 from public.disciplinary_warnings where id = v_w2 and warning_number is not null) then raise exception '0617 REFUSED: a refused warning was numbered.'; end if;
    perform public.decide_warning(v_w3, true, null, null);
    if (select warning_number from public.disciplinary_warnings where id = v_w3) <> 2
       or (select pending_termination_review from public.employees where id = v_guard) then
      raise exception '0617 REFUSED: with one formal 13 months ago, the second recent one was not number 2, or flagged early.';
    end if;

    -- the third approved formal inside 12 months flags and alerts
    insert into public.disciplinary_warnings (employee_id, reason, kind, status) values (v_guard, 'Third', 'formal', 'approved');
    if not (select pending_termination_review from public.employees where id = v_guard)
       or not exists (select 1 from public.alerts where ref_table = 'employees' and ref_id = v_guard and category = 'warnings' and state = 'open') then
      raise exception '0617 REFUSED: the third formal warning in 12 months did not flag or alert.';
    end if;

    -- payroll marks the fine applied, once
    perform public.mark_warning_fine_applied(v_w1);
    v_msg := null; begin perform public.mark_warning_fine_applied(v_w1); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'That fine is not waiting for payroll.' then raise exception '0617 REFUSED: applying a fine twice got "%".', v_msg; end if;

    -- a login without warnings.approve cannot write an approved formal warning directly
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin insert into public.disciplinary_warnings (employee_id, reason, kind, status) values (v_guard, 'Direct', 'formal', 'approved');
      exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Approving a formal warning needs the "Approve warnings" permission.' then raise exception '0617 REFUSED: a direct formal insert without the key got "%".', v_msg; end if;
    raise exception '0617-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0617-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0617 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0617 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0617 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
