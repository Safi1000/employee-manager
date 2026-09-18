-- 0459 — Stage D (the safe half): gate the two tables whose only writers are now
-- SECURITY DEFINER RPCs.
--
-- 0451 gated the RPC-fronted ledger/cash/pay tables and, in its own header,
-- deferred two groups: the INVOKER-backed tables "whose gate would fall on every
-- caller" (treasury, employee_salary_history) and the raw-write screens
-- (payslips, cash_*, cheques, fixed_assets, opening_balance_lines) that "must
-- route through an RPC first". Two things since have cleared treasury and
-- payroll_runs out of that deferral:
--
--   • 0453 made apply_money_delta SECURITY DEFINER, and 0458 (Stage C) removed
--     the last raw treasury writer from the browser (payroll disbursement). Every
--     treasury write is now a definer RPC — apply_money_delta, set_cash_opening_
--     balance — which runs as the table owner and is not subject to RLS.
--   • payroll_runs was never written from a screen; disburse_payroll_run /
--     payroll_run_attach (definer) are its only writers.
--
-- So a restrictive has_perm gate here blocks raw/API writes and cannot break a
-- sanctioned path — the exact safety condition 0451 required. The remaining
-- raw-write-screen tables (cash_locations, cash_deposits, cheques,
-- custody_transfers, opening_balance_lines, fixed_assets, payslips) still have
-- browser screens writing them directly and still need an RPC-routing pass first;
-- cash_locations especially, since the PAYROLL and EXPENSES cash flows create it
-- via ensureCustodianLocation and neither runs on accounting.edit. They are NOT
-- in this migration.
--
--   treasury      → accounting.edit
--   payroll_runs  → payroll.edit
--
-- Same RESTRICTIVE has_perm pattern as 0450/0451: restrictive, so it ANDs with
-- the permissive company_members/ssa_all base — a write needs company membership
-- AND the key. Reads are untouched. drop-if-exists keeps the file replay-safe.

do $mig$
declare spec record;
begin
  for spec in
    select tbl, key from (values
      ('treasury',     'accounting.edit'),
      ('payroll_runs', 'payroll.edit')
    ) as v(tbl, key)
  loop
    execute format($f$
      drop policy if exists perm_write_ins on public.%1$I;
      drop policy if exists perm_write_upd on public.%1$I;
      drop policy if exists perm_write_del on public.%1$I;
      create policy perm_write_ins on public.%1$I as restrictive for insert
        with check ((select public.has_perm(%2$L)));
      create policy perm_write_upd on public.%1$I as restrictive for update
        using ((select public.has_perm(%2$L)))
        with check ((select public.has_perm(%2$L)));
      create policy perm_write_del on public.%1$I as restrictive for delete
        using ((select public.has_perm(%2$L)));
    $f$, spec.tbl, spec.key);
  end loop;
end $mig$;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit')
   or not exists (select 1 from public.permission_keys where key = 'payroll.edit') then
    raise exception '0459 FAILED: accounting.edit / payroll.edit missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname in ('treasury','payroll_runs') and p.polname like 'perm_write_%';
  if v_n <> 6 then
    raise exception '0459 FAILED: expected 6 perm_write policies across the two tables, found %.', v_n;
  end if;
end $mig$;

-- No functions added; the tenant-guard surface is unchanged.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0459 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
