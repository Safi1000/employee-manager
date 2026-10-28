-- 0588 — every money table is read by whoever may open its screens
--
-- Phase 0, Migration C2. Shayan, 28 Oct 2026: "lets wrap it up in one go
-- leaving for later is not the wise option just wind it up". Follows 0586
-- (four tables) and 0587 (ledger triggers run as the ledger, so a table rule
-- here cannot blind a control inside one).
--
-- A CORRECTION FIRST. The measurement that fed 0586 counted 45 tables as
-- read-gated: any table with a restrictive policy naming has_perm. 26 of them
-- carry only 0424's self_scope, which narrows an EMPLOYEE-LINKED login to its
-- own rows and leaves every other login company-wide. Payslips, advances,
-- expenses, guard_bonuses and bonus_pool_allocations were readable by any
-- office login. The true count before 0586 was 19. Those five are gated here
-- too. (The HR tables 0424 covers — employees, attendance, documents — stay
-- HR-readable by design.)
--
-- THE RULE, as 0586: a RESTRICTIVE perm_read naming the keys of every screen
-- that reads the table (the union of their route guards and in-screen
-- conditions, mapped from src/app). Anyone who may open the screen keeps the
-- rows; anyone who may not, loses the back door. Where 0424 gave a linked
-- login its own rows (payslips, advances, expenses, bonuses), the rule keeps
-- them: `or (linked and the row is his)`.
--
-- Key sets used below:
--   BANK  banks.view accounting.edit reports.view cashflow.view accountant.view reversals.execute
--   ACCT  banks.view receivables.view payables.view accounting.edit       (Bank & Ledgers route)
--   JOUR  reports.view coa.view accounting.edit accountant.view period_close.manage reversals.execute
--   PAY   payroll.view payroll.edit payroll.approve payroll.adjust
--   EXP   expenses.view expenses.edit expenses.approve
--   INV   invoices.view invoices.edit receivables.view accounting.edit reports.view cashflow.view
--         period_close.manage accountant.view reversals.execute           (= INVOICE_READ_KEYS)
--   PART  ACCT + partnership.post
--   REP   reports.view accountant.view
--
-- payslips keeps employees.edit: the base-salary editor reads them, and whoever
-- may change a salary already sees it.
--
-- Asserted: every table carries one restrictive perm_read whose keys
-- public.permission_keys holds; as the HR login (unlinked, no region:
-- employees / attendance / expenses / assignments keys) each table reads ALL
-- its rows where that login holds one of its keys and NONE where it does not;
-- as Shayan each reads every row.

do $pol$
declare
  BANK constant text[] := '{banks.view,accounting.edit,reports.view,cashflow.view,accountant.view,reversals.execute}';
  ACCT constant text[] := '{banks.view,receivables.view,payables.view,accounting.edit}';
  JOUR constant text[] := '{reports.view,coa.view,accounting.edit,accountant.view,period_close.manage,reversals.execute}';
  PAY  constant text[] := '{payroll.view,payroll.edit,payroll.approve,payroll.adjust}';
  EXP  constant text[] := '{expenses.view,expenses.edit,expenses.approve}';
  INV  constant text[] := '{invoices.view,invoices.edit,receivables.view,accounting.edit,reports.view,cashflow.view,period_close.manage,accountant.view,reversals.execute}';
  REP  constant text[] := '{reports.view,accountant.view}';
  PART text[];
  t record; v_using text;
begin
  PART := ACCT || '{partnership.post}'::text[];
  for t in select * from (values
    -- ledger
    ('journal_entries_archive',        JOUR,                                   null::text),
    ('journal_lines_archive',          JOUR,                                   null),
    ('ledger_cutovers',                JOUR || BANK || ACCT,                   null),
    ('opening_balance_batches',        JOUR || BANK || ACCT,                   null),
    ('opening_balance_lines',          JOUR || ACCT,                           null),
    ('ho_allocation_runs',             REP || PART,                            null),
    ('ho_apportionment_settings',      REP || PART,                            null),
    ('reserve_policies',               BANK || REP,                            null),
    ('reversals',                      '{reversals.execute,audit_log.view}'::text[] || REP, null),
    ('interregion_transactions',       BANK || REP,                            null),
    ('fixed_assets',                   '{accounting.edit,inventory.view,inventory.edit,banks.view,audit_log.view}'::text[] || REP, null),
    ('depreciation_entries',           '{accounting.edit,inventory.view,inventory.edit,banks.view,audit_log.view}'::text[] || REP, null),
    -- cash and banks
    ('cash_deposits',                  ACCT || BANK || '{audit_log.view}'::text[], null),
    ('custody_transfers',              ACCT || BANK || '{audit_log.view}'::text[], null),
    ('cheques',                        BANK || ACCT || EXP || PAY || '{period_close.manage,invoices.edit,audit_log.view}'::text[], null),
    ('treasury',                       ACCT || EXP || INV,                     null),
    -- payables and expenses
    ('vendor_payments',                ACCT || BANK || '{audit_log.view}'::text[], null),
    ('vendor_credits',                 ACCT || BANK,                           null),
    ('vendor_credit_settlements',      ACCT || BANK,                           null),
    ('payable_payments',               ACCT || BANK || '{audit_log.view}'::text[], null),
    ('expense_receipts',               EXP || '{payables.view,accounting.edit,audit_log.view}'::text[], null),
    ('fixed_expenses',                 EXP || '{payables.view,accounting.edit}'::text[], null),
    ('fixed_expense_instances',        EXP || '{payables.view,accounting.edit}'::text[], null),
    ('expense_requests',               EXP || '{payables.view,accounting.edit,audit_log.view}'::text[], 'requested_by = (select auth.uid())'),
    ('expenses',                       EXP || PAY || ACCT || BANK || REP || '{period_close.manage,audit_log.view}'::text[], 'expense_by'),
    ('fuel_trips',                     ACCT || '{expenses.edit}'::text[],      null),
    ('inventory_purchases',            '{inventory.view,inventory.edit,accounting.edit,banks.view,audit_log.view}'::text[] || REP, null),
    ('inventory_purchase_lines',       '{inventory.view,inventory.edit,accounting.edit,banks.view}'::text[] || REP, null),
    -- payroll
    ('payslips',                       PAY || REP || ACCT || BANK || '{period_close.manage,employees.edit,audit_log.view}'::text[], 'employee_id'),
    ('advances',                       PAY || EXP || ACCT || BANK || '{period_close.manage,employees.view,employees.edit}'::text[], 'employee_id'),
    ('guard_bonuses',                  PAY || REP || '{performance.approve}'::text[], 'employee_id'),
    ('bonus_pool_allocations',         PAY || REP || '{performance.approve}'::text[], 'employee_id'),
    ('bonus_pools',                    PAY || REP || '{performance.approve}'::text[], null),
    ('bonus_accruals',                 PAY || REP,                             null),
    ('payroll_adjustments',            PAY || REP || '{reversals.execute,audit_log.view}'::text[], null),
    ('payslip_adjustments',            PAY || REP,                             null),
    ('payslip_payments',               PAY || REP || BANK,                     null),
    ('payslip_reward_lines',           PAY || REP,                             null),
    ('payroll_run_exception_acks',     PAY || REP,                             null),
    ('payroll_statutory_settings',     PAY || REP,                             null),
    ('statutory_remittances',          PAY || REP || '{payables.view,accounting.edit}'::text[], null),
    -- partners and investors
    ('profit_distribution_rules',      PART || REP,                            null),
    ('profit_distribution_rule_lines', PART || REP,                            null),
    ('referral_arrangements',          PART || REP,                            null),
    ('partner_client_shares',          PART || REP,                            null),
    ('finance_investors',              ACCT || BANK,                           null),
    ('finance_projects',               ACCT || BANK,                           null),
    ('project_investments',            ACCT || BANK,                           null),
    ('investor_ledger_entries',        ACCT || BANK,                           null),
    -- invoicing and sales tax
    ('invoice_lines',                  INV,                                    null),
    ('invoice_taxes',                  INV,                                    null),
    ('invoice_reminders',              INV,                                    null),
    ('invoice_generation_drafts',      INV,                                    null),
    ('sales_tax_returns',              REP || '{payables.view,accounting.edit,invoices.edit}'::text[], null),
    ('sales_tax_return_lines',         REP || '{payables.view,accounting.edit,invoices.edit}'::text[], null),
    ('sales_tax_payments',             REP || '{payables.view,accounting.edit,invoices.edit}'::text[], null),
    ('sales_tax_authorities',          REP || '{payables.view,accounting.edit,invoices.edit}'::text[], null),
    ('sales_tax_rates',                REP || '{payables.view,accounting.edit,invoices.edit}'::text[], null),
    -- the product's own billing (super-super-admin reads through has_perm)
    ('subscription_payments',          '{settings.view,settings.edit}'::text[], null),
    ('billing_events',                 '{settings.view,settings.edit}'::text[], null),
    ('ai_credit_ledger',               '{settings.view,settings.edit}'::text[], null)
  ) as x(tbl, keys, own)
  loop
    v_using := (select string_agg(format('(select public.has_perm(%L))', k), ' or ') from (select distinct unnest(t.keys) k order by 1) s);
    if t.own = 'requested_by = (select auth.uid())' then
      v_using := v_using || ' or requested_by = (select auth.uid())';
    elsif t.own is not null then
      v_using := v_using || format(' or ((select public.is_employee_linked()) and %I = (select public.current_user_employee_id()))', t.own);
    end if;
    execute format('drop policy if exists perm_read on public.%I', t.tbl);
    execute format('create policy perm_read on public.%I as restrictive for select to public using (%s)', t.tbl, v_using);
  end loop;
end $pol$;

do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR, unlinked, no region
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  t record; v_all bigint; v_hr_n bigint; v_boss_n bigint; v_holds boolean; v_bad text; v_n int := 0;
begin
  select string_agg(distinct k, ', ') into v_bad
    from pg_policies p, regexp_matches(p.qual, 'has_perm\(''([a-z_.]+)''', 'g') m(a), unnest(m.a) k
   where p.schemaname = 'public' and p.policyname = 'perm_read'
     and not exists (select 1 from public.permission_keys pk where pk.key = k);
  if v_bad is not null then raise exception '0588 REFUSED: keys the grant screen cannot offer: %', v_bad; end if;

  for t in
    select p.tablename, p.qual from pg_policies p
     where p.schemaname = 'public' and p.policyname = 'perm_read' and p.permissive = 'RESTRICTIVE'
       and p.tablename in ('journal_entries_archive','journal_lines_archive','ledger_cutovers','opening_balance_batches','opening_balance_lines',
         'ho_allocation_runs','ho_apportionment_settings','reserve_policies','reversals','interregion_transactions','fixed_assets','depreciation_entries',
         'cash_deposits','custody_transfers','cheques','treasury','vendor_payments','vendor_credits','vendor_credit_settlements','payable_payments',
         'expense_receipts','fixed_expenses','fixed_expense_instances','expense_requests','expenses','fuel_trips','inventory_purchases',
         'inventory_purchase_lines','payslips','advances','guard_bonuses','bonus_pool_allocations','bonus_pools','bonus_accruals','payroll_adjustments',
         'payslip_adjustments','payslip_payments','payslip_reward_lines','payroll_run_exception_acks','payroll_statutory_settings','statutory_remittances',
         'profit_distribution_rules','profit_distribution_rule_lines','referral_arrangements','partner_client_shares','finance_investors','finance_projects',
         'project_investments','investor_ledger_entries','invoice_lines','invoice_taxes','invoice_reminders','invoice_generation_drafts','sales_tax_returns',
         'sales_tax_return_lines','sales_tax_payments','sales_tax_authorities','sales_tax_rates','subscription_payments','billing_events','ai_credit_ledger')
  loop
    v_n := v_n + 1;
    -- what GGS holds: by company_id where the table has one, else every row
    -- (journal_lines_archive, opening_balance_lines, profit_distribution_rule_lines
    -- reach the company through a parent the logins' own policies already scope)
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t.tablename and column_name = 'company_id') then
      execute format('select count(*) from public.%I where company_id = %L', t.tablename, '7f7899a0-edd2-4491-a40d-f81b54c68d1e') into v_all;
    else
      execute format('select count(*) from public.%I', t.tablename) into v_all;
    end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    select exists (select 1 from regexp_matches(t.qual, 'has_perm\(''([a-z_.]+)''', 'g') m(a) where public.has_perm(m.a[1])) into v_holds;
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t.tablename) into v_hr_n;
    execute 'reset role';

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t.tablename) into v_boss_n;
    execute 'reset role';

    if v_holds and v_hr_n <> v_all then
      raise exception '0588 REFUSED: HR holds a key of % yet reads % of % rows.', t.tablename, v_hr_n, v_all;
    end if;
    if not v_holds and v_hr_n <> 0 then
      raise exception '0588 REFUSED: HR holds no key of % yet reads % rows.', t.tablename, v_hr_n;
    end if;
    if v_boss_n <> v_all then
      raise exception '0588 REFUSED: Shayan reads % of % rows of %.', v_boss_n, v_all, t.tablename;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  if v_n <> 61 then raise exception '0588 REFUSED: % tables carry the policy, expected 61.', v_n; end if;
end $test$;
