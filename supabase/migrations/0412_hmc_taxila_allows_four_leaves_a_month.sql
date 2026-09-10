-- 0412: HMC Taxila grants four leaves a month, to every guard on the client.
--
-- The contract (77cc83c9, 2026-07-01 → 2027-06-30) already said 4. It was
-- reaching three people. `resolveAllowedLeaves` in src/app/lib/supabase.ts
-- reads the CONTRACT the employee is assigned to and falls back to the CLIENT
-- only when that assignment is null — and 125 of HMC Taxila's 128 employees
-- carry no `contract_id` at all, so the number they actually got was the
-- client's, which was 0.
--
-- This is the failure the client fallback exists to absorb, and it was empty.
-- The fix is the fallback, not the assignment: writing `contract_id` onto 125
-- employees would also route them through the contract's EOBI (370.00), which
-- is a different question nobody asked. Set the client default to 4 so it
-- agrees with the contract, and both paths land on the same number.
--
-- Nothing is backfilled because nothing was stored: `payslips` has no
-- allowed-leaves column. The allowance is resolved when the period is opened,
-- so every month — past or future — recomputes at 4 the next time it is loaded.
--
-- DEFERRED: whether HMC Taxila's 125 unassigned employees should be attached to
-- contract 77cc83c9. If the answer is yes, the change is an update of
-- employees.contract_id for that client, and it moves EOBI as well as leaves;
-- the client fallback set here would then be redundant but not wrong.
do $$
declare
  v_client uuid;
  v_rows   int;
begin
  select id into v_client
  from public.clients
  where employee_id_prefix = 'HMC' and name = 'HMC Taxila';

  if v_client is null then
    raise notice '0412: no HMC Taxila client on this database; nothing to do';
    return;
  end if;

  update public.clients
     set allowed_leaves_per_month = 4
   where id = v_client
     and allowed_leaves_per_month is distinct from 4;

  get diagnostics v_rows = row_count;
  raise notice '0412: client rows updated = %', v_rows;

  -- The contract is the other half of the resolution chain. A contract value of
  -- null means "inherit", which is now also 4, so only a contract that names a
  -- DIFFERENT number needs correcting.
  update public.contracts
     set allowed_leaves_per_month = 4
   where client_id = v_client
     and allowed_leaves_per_month is not null
     and allowed_leaves_per_month <> 4;

  get diagnostics v_rows = row_count;
  raise notice '0412: contract rows updated = %', v_rows;

  -- Assert the condition that can break, not the one that moved: every path an
  -- HMC employee can take through resolveAllowedLeaves must now yield 4.
  perform 1
  from public.employees e
  left join public.contracts c on c.id = e.contract_id
  where e.client_id = v_client
    and coalesce(c.allowed_leaves_per_month,
                 (select allowed_leaves_per_month from public.clients where id = v_client)) <> 4;

  if found then
    raise exception '0412: an HMC Taxila employee still resolves to an allowance other than 4';
  end if;
end $$;

-- The tenant guard assertion. This migration adds no function and no parameter,
-- so it cannot open a gap of its own — but the detector is cheap and a green
-- run here is evidence about the database, not only about this file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
