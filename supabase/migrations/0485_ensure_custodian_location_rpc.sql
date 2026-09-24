-- 0485 — ensure_custodian_location: the auto-create-on-first-use path for a
-- custodian cash_location becomes a SECURITY DEFINER RPC.
--
-- A custodian location is an EMPTY container (opening_balance 0); creating it is
-- not a money movement, so it needs no money key. It is created from three flows
-- on three different keys — cash payroll (payroll.edit), cash expenses
-- (expenses.edit), cash cheques (accounting.edit) — so the RPC asserts only
-- company membership (assert_same_company on the company) and person validity (the
-- person's company matches). The money RPC that later puts cash into it asserts
-- its own key. This is what lets the cash_locations table be gated on
-- accounting.edit (a FOLLOW-UP migration, after the frontend is deployed) without
-- breaking cash payroll: this definer RPC bypasses the gate.
--
-- The gate is intentionally NOT in this migration — applying it while the old
-- (raw-insert) frontend is still deployed would break first-use custodian create
-- for a payroll/expenses user. Apply the gate after the frontend routes here.

create or replace function public.ensure_custodian_location(
  p_company_id uuid,
  p_person_id  uuid,
  p_kind       text default null
) returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
as $fn$
declare v_kind text; v_name text; v_id uuid;
begin
  -- Company membership: assert_same_company raises unless p_company_id is the
  -- caller's company (or the caller is unscoped SSA). No edit key required.
  perform public.assert_same_company(p_company_id);

  -- Detect employee vs partner when the caller didn't say (a partner id must not
  -- land in custodian_employee_id, an FK to employees, and vice-versa).
  v_kind := p_kind;
  if v_kind is null then
    v_kind := case when exists (select 1 from public.partners where id = p_person_id)
                   then 'partner' else 'employee' end;
  end if;

  if v_kind = 'partner' then
    -- Person validity + tenant: the partner must belong to the same company.
    perform public.assert_same_company((select company_id from public.partners where id = p_person_id));
    select id into v_id from public.cash_locations
      where company_id = p_company_id and custodian_partner_id = p_person_id
        and location_type = 'CUSTODIAN' limit 1;
    if v_id is not null then return v_id; end if;
    select name into v_name from public.partners where id = p_person_id;
    insert into public.cash_locations
      (company_id, name, location_type, custodian_partner_id, opening_balance, is_active)
    values (p_company_id, v_name, 'CUSTODIAN', p_person_id, 0, true)
    returning id into v_id;
  else
    perform public.assert_same_company((select company_id from public.employees where id = p_person_id));
    select id into v_id from public.cash_locations
      where company_id = p_company_id and custodian_employee_id = p_person_id
        and location_type = 'CUSTODIAN' limit 1;
    if v_id is not null then return v_id; end if;
    select full_name into v_name from public.employees where id = p_person_id;
    insert into public.cash_locations
      (company_id, name, location_type, custodian_employee_id, opening_balance, is_active)
    values (p_company_id, v_name, 'CUSTODIAN', p_person_id, 0, true)
    returning id into v_id;
  end if;

  return v_id;
end $fn$;

grant execute on function public.ensure_custodian_location(uuid, uuid, text) to authenticated;

-- ── tenant-guard assertion ───────────────────────────────────────────────────
-- p_company_id, p_person_id are both covered above (assert_same_company naming
-- each). Assert the detector stays empty.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0485 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
