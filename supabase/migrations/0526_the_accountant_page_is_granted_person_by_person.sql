-- 0526 — accountant.view joins the permission catalogue
--
-- The Accountant page (2026-10-20 redesign) is the accountant's working
-- surface: every bank and cash ledger for the month, the controls and the rows
-- behind them, the ledgers, scenarios and contracted-vs-deployed. Shayan asked
-- that it be granted from Access & Governance to the people he chooses, not
-- reached by anyone who can read reports.
--
-- The route asks `accountant.view` and the grant screen offers it
-- (PERMISSION_GROUPS, src/app/lib/supabase.ts). A key the grant screen offers
-- but permission_keys does not list turns `every_demanded_permission_is_
-- grantable` red the night it ships — the catalogue and the screen are two
-- copies of one list (see CLAUDE.md, "A key the grant screen cannot offer").
-- This adds the database's copy.
--
-- Nothing else changes: no function, policy or table reads the key yet. The
-- page's figures all come from functions it already had the rights to call
-- (ledger_statement, ledger_checks, cash_accrual_bridge, scenario_compare,
-- client_cover), each with its own gate.
--
-- Idempotent: on conflict do nothing.

insert into public.permission_keys (key, grp, label)
values ('accountant.view', 'Reports & Finance', 'View the Accountant page (accounts, checks, ledgers, scenarios)')
on conflict (key) do nothing;

do $$
begin
  if not exists (select 1 from public.permission_keys where key = 'accountant.view') then
    raise exception '0526 REFUSED: accountant.view is not in permission_keys after the insert.';
  end if;
end $$;

-- Tenant guards: nothing here touches a function body; the detector must still
-- read clean.
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
