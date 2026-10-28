-- 0589 — the audit log is read by whoever may read what it records; backups by nobody
--
-- Phase 0, C3. Shayan, 28 Oct 2026: "lets wrap it up in one go … just wind it up".
--
-- 1. AUDIT LOG. 54,000 rows of old and new values of every change — salaries,
--    payments, bank movements — readable by any login (company_members_read).
--    Now a RESTRICTIVE perm_read:
--      audit_log.view                          → every row (the Audit Log screen)
--      employees.view / employees.edit         → rows about `employees`
--                                                (employee_identity_amendments, read by Employees)
--      contracts.view / contracts.edit         → rows about `contracts`
--                                                (contract_amendment_history, read by Contracts)
--    amend_employee_identity / unverify_employee_identity only INSERT here, and
--    the header's "changed since" chip runs for super-admins only.
--
-- 2. FIVE BACKUP TABLES — attendance_deleted_0413_backup,
--    deployment_dates_backup_0415, deployments_overlap_backup_0183,
--    employee_branch_realign_backup_20260618, org_copy_map_0186 — copies made by
--    past data repairs, read by no screen. Readable by the super-super-admin
--    only. record_separation writes its archive through an owner-only path
--    (0403); sync_attendance_0188 is a one-off from 0188.
--
-- 3. A CUSTODIAN'S OWN CASH. 0586 hid the "cash held" card on My Profile from
--    anyone without banking access, because the browser folded it from tables
--    that login can no longer read. my_cash_held() returns the caller's own
--    figure — custodian_held_operational() for the cash location whose
--    custodian is the employee his login is linked to — and nothing else. The
--    DEFERRED note on 0586 is answered here.
--
-- 4. DECIDED, so the open ones do not read as forgotten:
--      statutory_rates, statutory_filings — rates and due dates, not money.
--      payroll_run_phases — the attendance run's progress, read by the
--        attendance screens.
--      employee_state_snapshots — HR record snapshots for reversals; HR reads
--        employees already.
--
-- Asserted: as the HR login (employees keys, no audit_log.view, no contracts
-- key) the audit log reads exactly its rows about employees and none about
-- anything else; Shayan reads every row of the company; no user role (anon,
-- authenticated) holds SELECT on any backup; my_cash_held() returns null for an unlinked login and, for a
-- linked custodian, the same figure custodian_held_operational() gives.

-- ── 1. audit log ────────────────────────────────────────────────────────────
drop policy if exists perm_read on public.audit_log;
create policy perm_read on public.audit_log as restrictive for select to public using (
  (select public.has_perm('audit_log.view'))
  or (table_name = 'employees' and ((select public.has_perm('employees.view')) or (select public.has_perm('employees.edit'))))
  or (table_name = 'contracts' and ((select public.has_perm('contracts.view')) or (select public.has_perm('contracts.edit'))))
);

-- ── 2. backups ──────────────────────────────────────────────────────────────
do $bk$
declare t text;
begin
  foreach t in array array['attendance_deleted_0413_backup','deployment_dates_backup_0415','deployments_overlap_backup_0183',
                           'employee_branch_realign_backup_20260618','org_copy_map_0186'] loop
    -- four were already granted to the owner only; employee_branch_realign_backup_20260618
    -- was still granted to anon and authenticated. No user role holds any of them now.
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ssa_only on public.%I', t);
    execute format('create policy ssa_only on public.%I as restrictive for all to public using ((select public.is_super_super_admin())) with check ((select public.is_super_super_admin()))', t);
    execute format('comment on table public.%I is %L', t,
      'DECIDED 0589: a copy made by a past data repair; read by no screen; readable by the super-super-admin only.');
  end loop;
end $bk$;

-- ── 3. a custodian's own cash ───────────────────────────────────────────────
create or replace function public.my_cash_held()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  -- 0589. The caller's own custody, and nobody else's: the cash location whose
  -- custodian is the employee this login is linked to. Null when the login is
  -- not linked or the employee holds no custody.
  select h.operational
    from public.cash_locations cl
    join public.custodian_held_operational(cl.company_id) h on h.cash_location_id = cl.id
   where cl.custodian_employee_id = public.current_user_employee_id()
     and cl.company_id = public.current_company_id()
     and cl.location_type = 'CUSTODIAN'
   limit 1;
$$;
comment on function public.my_cash_held() is
  'TENANT GUARD EXEMPT: takes no argument; reads only the caller''s own linked employee and company. '
  '0589: the cash a custodian holds, for his own My Profile — without banking access.';
revoke all on function public.my_cash_held() from public, anon;
grant execute on function public.my_cash_held() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('my_cash_held', null, 'EXEMPT 0589: returns only the caller''s own custody figure')
on conflict (function_name) do nothing;

-- ── 4. decided ──────────────────────────────────────────────────────────────
comment on table public.statutory_rates is 'DECIDED 0589: read company-wide — contribution rates, not money.';
comment on table public.statutory_filings is 'DECIDED 0589: read company-wide — filing due dates for the compliance screens, not money.';
comment on table public.payroll_run_phases is 'DECIDED 0589: read company-wide — the attendance run''s progress, read by the attendance screens.';
comment on table public.employee_state_snapshots is 'DECIDED 0589: read as employees are — HR record snapshots kept for reversals.';

-- ── proof ───────────────────────────────────────────────────────────────────
do $test$
declare
  v_co     constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_hr     constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR: employees keys; no audit_log.view, no contracts key; unlinked
  v_linked constant uuid := '14b31508-a41d-4187-8b11-9bc7926f7488';   -- the one employee-linked login
  v_boss   constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  v_all bigint; v_emp bigint; v_n bigint; t text; v_mine numeric; v_want numeric;
begin
  select count(*), count(*) filter (where table_name = 'employees') into v_all, v_emp from public.audit_log where company_id = v_co;

  perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
  if public.has_perm('audit_log.view') or public.has_perm('contracts.view') or public.has_perm('contracts.edit') then
    raise exception '0589 REFUSED: the HR test login holds a key the test assumes it lacks.';
  end if;
  execute 'set local role authenticated';
  select count(*) into v_n from public.audit_log;
  execute 'reset role';
  if v_n <> v_emp then raise exception '0589 REFUSED: HR reads % audit rows; its rows about employees number %.', v_n, v_emp; end if;
  foreach t in array array['attendance_deleted_0413_backup','deployment_dates_backup_0415','deployments_overlap_backup_0183',
                           'employee_branch_realign_backup_20260618','org_copy_map_0186'] loop
    if has_table_privilege('authenticated', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception '0589 REFUSED: a user role can still select from %.', t;
    end if;
  end loop;
  if public.my_cash_held() is not null then raise exception '0589 REFUSED: an unlinked login has a cash figure.'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_n from public.audit_log;
  execute 'reset role';
  if v_n <> v_all then raise exception '0589 REFUSED: Shayan reads % of % audit rows.', v_n, v_all; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_linked, 'role', 'authenticated')::text, true);
  v_mine := public.my_cash_held();
  select h.operational into v_want
    from public.cash_locations cl join public.custodian_held_operational(v_co) h on h.cash_location_id = cl.id
   where cl.custodian_employee_id = (select employee_id from public.profiles where id = v_linked) and cl.location_type = 'CUSTODIAN'
   limit 1;
  if v_mine is distinct from v_want then raise exception '0589 REFUSED: my_cash_held() gave %, custody shows %.', v_mine, v_want; end if;
  perform set_config('request.jwt.claims', '', true);
end $test$;
