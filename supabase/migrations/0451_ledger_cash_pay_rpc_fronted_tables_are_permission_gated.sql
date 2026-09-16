-- 0451 — Pass 1 of the ledger/cash/pay authorization pass: gate the RPC-fronted
-- tables.
--
-- Part A of the write-authorization audit found these tables writable by any
-- company member: a permissive company_members(ALL) + ssa_all base with no
-- server-side permission gate. This pass closes the subset whose ONLY non-trigger
-- writer is a SECURITY DEFINER RPC, so a restrictive write gate blocks raw
-- (screen) writes and cannot break a sanctioned path — a definer function runs as
-- the table owner and is not subject to RLS (none of these tables force RLS).
--
--   accounting.edit  — journal_entries, journal_lines (via post_journal /
--                      reverse_journal_for_source), interregion_transactions
--                      (fund_region), depreciation_entries (run_depreciation)
--   payroll.adjust   — payroll_adjustments (raise_/settle_/cancel_/
--                      settle_carried_payroll_adjustment)
--
-- Same RESTRICTIVE has_perm pattern contracts and (0450) contract_lines carry:
-- restrictive, so it ANDs with the permissive company/ssa policies — a write
-- needs company membership AND the key. Reads are untouched.
--
-- NOT in this pass (different treatment, separate authorisation): the
-- INVOKER-backed tables (treasury, employee_salary_history) whose gate would fall
-- on every caller, and the raw-write screens (payslips, cash_*, cheques,
-- fixed_assets, opening_balance_lines) that must route through an RPC first.

do $mig$
declare
  spec record;
begin
  for spec in
    select tbl, key from (values
      ('journal_entries',         'accounting.edit'),
      ('journal_lines',           'accounting.edit'),
      ('interregion_transactions','accounting.edit'),
      ('depreciation_entries',    'accounting.edit'),
      ('payroll_adjustments',     'payroll.adjust')
    ) as v(tbl, key)
  loop
    execute format($f$
      create policy perm_write_ins on public.%I as restrictive for insert
        with check ((select public.has_perm(%L)));
      create policy perm_write_upd on public.%I as restrictive for update
        using ((select public.has_perm(%L)))
        with check ((select public.has_perm(%L)));
      create policy perm_write_del on public.%I as restrictive for delete
        using ((select public.has_perm(%L)));
    $f$, spec.tbl, spec.key, spec.tbl, spec.key, spec.key, spec.tbl, spec.key);
  end loop;
end $mig$;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  -- Both demanded keys must be grantable (mirrors permission_key_gaps discipline).
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit')
   or not exists (select 1 from public.permission_keys where key = 'payroll.adjust') then
    raise exception '0451 FAILED: accounting.edit / payroll.adjust missing from permission_keys.';
  end if;
  -- 5 tables x 3 write policies.
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname in ('journal_entries','journal_lines','interregion_transactions',
                        'depreciation_entries','payroll_adjustments')
      and p.polname like 'perm_write_%';
  if v_n <> 15 then
    raise exception '0451 FAILED: expected 15 perm_write policies across the five tables, found %.', v_n;
  end if;
end $mig$;

-- No functions added, so the tenant-guard surface is unchanged.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0451 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
