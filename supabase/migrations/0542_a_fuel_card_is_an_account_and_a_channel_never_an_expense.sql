-- 0542 — a fuel card is an account and a channel, never an expense by itself
--
-- DECIDED 2026-10-16 (Shayan), built 2026-10-22. A fuel card is an account
-- with a balance, loaded from a bank account. It has two roles, and they must
-- not merge:
--
--   ALLOWANCE (compensation). A fixed allowance is an earning line on the
--   payslip — `allowance`, untaxed, part of final_salary, as it already is —
--   paid through a channel. The card is that channel: Shayan's 130,000 is
--   100,000 to the bank and 30,000 to his card, or 15,000/15,000 with cash.
--   No receipts, no balance tracking, no reimbursement of excess. The money
--   leaves the bank that loads it; after that it is his. Booking it as an
--   expense is the defect this replaces.
--
--   FLOAT (company asset). Loads add, bills subtract, the balance is the
--   company's. Spending is fuel expense; the unspent balance is an asset.
--   Shaped like the custodian float: each card is a leaf under 1020 Fuel
--   Cards, its balance IS its ledger account, and nothing else holds a copy.
--
-- What this adds:
--   * 1020 Fuel Cards (control) and a 1020.NN leaf per float card.
--   * fuel_cards — both roles in one register, kept apart by constraint: a
--     float card has a ledger account and no holder's pay; an allowance card
--     has a holder and no ledger account.
--   * load_fuel_card / reverse_fuel_card_load — bank → card through
--     apply_money_delta (kind 'fuel_card'), Dr card / Cr bank.
--   * record_fuel_card_bill — an expense with payment_mode 'Card' naming its
--     float card: Dr fuel expense / Cr the card. Refused beyond the card's
--     balance. It is an expenses row, so every statement, the tie-out and the
--     partnership read it where they read every other expense.
--   * 'Card' as a payslip channel: disburse_payslip takes p_fuel_card_id (an
--     allowance card held by that payslip's employee) and the bank that funds
--     the load; the money moves from that bank through apply_money_delta, and
--     0541's per-channel posting credits that bank.
--   * fuel_card_readings + fuel_card_portal_gaps + a ledger check,
--     fuel_cards_agree_with_attock_portal: a float card whose latest Attock
--     portal figure differs from Bastion's balance on that date, that has
--     never been read, or that Bastion holds below zero, is red.
--
-- Amended by surgery against the live definition, each anchor asserted to
-- appear exactly once: settlement_account, journal_on_expense,
-- disburse_payslip (re-created with the added parameter), reverse_payslip_
-- disbursement, ledger_checks, and the six cash-basis readers of an expense's
-- cash date — client_statement_loaded, ho_pool, regional_pl_range,
-- regional_cash_hunger, statement_tieout, unplaced_money — each of which read
-- `payment_mode in ('Cash','Bank') then expense_date` and would have dropped a
-- card bill from every statement without a sound.
--
-- No data moves. The 15,000 "head office fuel allowance" expense of 30 Sept
-- (the other half of Shayan's September allowance) is NOT touched here: moving
-- it onto his payslip is a prod data change of its own and needs its own
-- named approval.
--
-- Asserted on the things that can break, inside blocks rolled back by
-- sentinels whose MESSAGES are checked:
--   (1) a float card loaded 10,000 and billed 2,500 (for Emaar) holds 7,500 in
--       its ledger account, the bank fell by 10,000, and Emaar's October
--       direct expenses rise by exactly the bill — not the load;
--   (2) a bill beyond the balance is refused with its own message;
--   (3) Shayan's September payslip finished with 15,000 to his card credits
--       the funding bank 129,500 in all, and his payslip says Card;
--   (4) the canary agrees with itself (passed), read from its own row — not
--       from a total row count, which moves with any added check.

do $mig$
declare
  v_src text; v_cnt int; v_a text; r record;
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_fn text;
  v_before numeric; v_after numeric; v_t0 numeric; v_t1 numeric;
  v_card uuid; v_acard uuid; v_bank uuid; v_bal0 numeric; v_bal1 numeric; v_gl numeric;
  v_ps uuid; v_bank_cr numeric; v_cat uuid; v_br uuid; v_emp uuid; v_cl uuid;
  v_gaps_before text[];
begin
  select sum(direct_expenses) into v_before
    from public.client_statement_loaded('2026-09-01', '2026-09-30', 'cash', v_co);
  -- The branch-guard gaps as they stand. disburse_payslip has written payslips
  -- without a branch check since 0458 (one of the 15 on 17 Oct); this migration
  -- must add none, not close what it did not open.
  select coalesce(array_agg(g.function_name || '/' || g.subject), '{}') into v_gaps_before
    from public.branch_guard_gaps() g where g.shape = 'writes';

  -- ── 1. the chart: 1020 Fuel Cards ───────────────────────────────────────────
  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
  select c.company_id, '1020', 'Fuel Cards', 'asset', 'debit', 'fuel_cards', true, true, true,
         'Company float held on fuel cards; one 1020.NN leaf per card. 0542.'
    from (select distinct company_id from public.chart_of_accounts where system_key = 'ar') c
   where not exists (select 1 from public.chart_of_accounts x
                      where x.company_id = c.company_id
                        and (x.system_key = 'fuel_cards' or x.account_code = '1020'));

  alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
  alter table public.bank_transactions add constraint bank_transactions_kind_check check (kind = any (array[
    'opening', 'deposit', 'withdraw_to_cash', 'payroll', 'reconcile', 'adjustment', 'cash_adjustment',
    'expense', 'receipt', 'advance', 'transfer', 'cheque', 'partner_entry', 'security_deposit', 'fuel_card']));

  -- ── 2. the register ─────────────────────────────────────────────────────────
  create table if not exists public.fuel_cards (
    id                 uuid primary key default gen_random_uuid(),
    company_id         uuid not null references public.companies(id),
    role               text not null check (role in ('float', 'allowance')),
    label              text not null check (btrim(label) <> ''),
    provider           text not null default 'Attock',
    card_last4         text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
    holder_employee_id uuid references public.employees(id),
    branch_id          uuid references public.branches(id),
    coa_account_id     uuid references public.chart_of_accounts(id),
    is_active          boolean not null default true,
    notes              text,
    created_by         uuid default auth.uid(),
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    -- The two roles never merge: a float card is a company account; an
    -- allowance card is a man's, and the company tracks nothing on it.
    constraint fuel_cards_float_has_an_account check (role <> 'float' or coa_account_id is not null),
    constraint fuel_cards_allowance_has_no_account check (role <> 'allowance' or (coa_account_id is null and holder_employee_id is not null))
  );
  create index if not exists fuel_cards_company_idx on public.fuel_cards (company_id, role);
  create unique index if not exists fuel_cards_account_uidx on public.fuel_cards (coa_account_id) where coa_account_id is not null;
  comment on table public.fuel_cards is
    'DECIDED 2026-10-16 (0542). role float = company float, balance is its 1020.NN ledger account; '
    'role allowance = the card a man''s fixed allowance is paid onto, no balance tracked. '
    'Written only by register_fuel_card / set_fuel_card_active.';

  create table if not exists public.fuel_card_loads (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references public.companies(id),
    fuel_card_id    uuid not null references public.fuel_cards(id),
    bank_account_id uuid not null references public.bank_accounts(id),
    amount          numeric(14,2) not null check (amount > 0),
    loaded_on       date not null,
    note            text,
    journal_id      uuid references public.journal_entries(id),
    created_by      uuid default auth.uid(),
    created_at      timestamptz not null default now()
  );
  create index if not exists fuel_card_loads_card_idx on public.fuel_card_loads (fuel_card_id, loaded_on);

  create table if not exists public.fuel_card_readings (
    id             uuid primary key default gen_random_uuid(),
    company_id     uuid not null references public.companies(id),
    fuel_card_id   uuid not null references public.fuel_cards(id),
    as_of          date not null,
    portal_balance numeric(14,2) not null,
    note           text,
    entered_by     uuid default auth.uid(),
    created_at     timestamptz not null default now()
  );
  create index if not exists fuel_card_readings_card_idx on public.fuel_card_readings (fuel_card_id, as_of desc, created_at desc);
  comment on table public.fuel_card_readings is
    '0542. The balance the Attock portal shows for a float card on a date, typed in. '
    'fuel_card_portal_gaps compares the latest one with Bastion''s balance on that date.';

  -- RLS: read with the money keys (as 0533); written only through the RPCs below.
  foreach v_fn in array array['fuel_cards', 'fuel_card_loads', 'fuel_card_readings'] loop
    execute format('alter table public.%I enable row level security', v_fn);
    execute format('drop policy if exists company_members on public.%I', v_fn);
    execute format('create policy company_members on public.%I as permissive for select using (company_id = (select public.current_company_id()))', v_fn);
    execute format('drop policy if exists ssa_all on public.%I', v_fn);
    execute format('create policy ssa_all on public.%I as permissive for select using ((select public.is_ssa_unscoped()))', v_fn);
    execute format('drop policy if exists perm_read on public.%I', v_fn);
    execute format($p$create policy perm_read on public.%I as restrictive for select using (
      (select public.has_perm('banks.view')) or (select public.has_perm('accounting.edit')) or (select public.has_perm('reports.view'))
      or (select public.has_perm('cashflow.view')) or (select public.has_perm('accountant.view'))
      or (select public.has_perm('payroll.view')) or (select public.has_perm('expenses.edit')))$p$, v_fn);
    execute format('revoke all on public.%I from anon', v_fn);
    execute format('revoke insert, update, delete on public.%I from authenticated', v_fn);
    execute format('grant select on public.%I to authenticated', v_fn);
    execute format('drop trigger if exists trg_zzz_%s_audit on public.%I', v_fn, v_fn);
    execute format('create trigger trg_zzz_%s_audit after insert or update or delete on public.%I for each row execute function public.log_audit_change()', v_fn, v_fn);
  end loop;

  -- ── 3. 'Card' on expenses (float bills) and payslips (allowance channel) ────
  alter table public.expenses add column if not exists fuel_card_id uuid references public.fuel_cards(id);
  alter table public.expenses drop constraint if exists expenses_payment_mode_check;
  alter table public.expenses add constraint expenses_payment_mode_check
    check (payment_mode = any ('{Cash,Bank,Cheque,Payable,Card}'::text[]));
  alter table public.expenses drop constraint if exists expenses_card_names_its_card;
  alter table public.expenses add constraint expenses_card_names_its_card
    check (payment_mode <> 'Card' or fuel_card_id is not null);

  alter table public.payslips add column if not exists fuel_card_id uuid references public.fuel_cards(id);
  alter table public.payslips drop constraint if exists payslips_payment_mode_check;
  alter table public.payslips add constraint payslips_payment_mode_check
    check (payment_mode = any ('{Cash,Bank,Cheque,Card}'::text[]));

  alter table public.payslip_payments add column if not exists fuel_card_id uuid references public.fuel_cards(id);
  alter table public.payslip_payments drop constraint if exists payslip_payments_payment_mode_check;
  alter table public.payslip_payments add constraint payslip_payments_payment_mode_check
    check (payment_mode in ('Cash', 'Bank', 'Cheque', 'Card'));
  alter table public.payslip_payments drop constraint if exists payslip_payment_card_names_card_and_bank;
  alter table public.payslip_payments add constraint payslip_payment_card_names_card_and_bank
    check (payment_mode <> 'Card' or (fuel_card_id is not null and bank_account_id is not null));

  -- ── 4. settlement_account: a payslip's card part settles from its bank ──────
  v_src := pg_get_functiondef('public.settlement_account(uuid,text,uuid,uuid,boolean)'::regprocedure);
  if position('0542' in v_src) = 0 then
    v_a := E'  elsif p_payment_mode = ''Carry-forward'' then\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: settlement_account anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  elsif p_payment_mode = ''Card'' then\n'
      || E'    -- 0542: an allowance paid onto a man''s fuel card left the bank that loaded\n'
      || E'    -- it. A FLOAT card bill never reaches here — journal_on_expense credits the\n'
      || E'    -- card''s own 1020.NN account directly.\n'
      || E'    if p_bank_account_id is null then\n'
      || E'      raise exception ''A card payment names the bank that loaded the card; none was given (0542)'' using errcode = ''23514'';\n'
      || E'    end if;\n'
      || E'    return public.bank_account_gl(p_company_id, p_bank_account_id);\n'
      || v_a);
    execute v_src;
  end if;

  -- ── 5. journal_on_expense: a card bill credits the card ─────────────────────
  v_src := pg_get_functiondef('public.journal_on_expense()'::regprocedure);
  if position('0542' in v_src) = 0 then
    v_a := E'       or old.bank_account_id is distinct from new.bank_account_id      -- 0276\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: journal_on_expense repost anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'       or old.fuel_card_id is distinct from new.fuel_card_id            -- 0542\n');

    v_a := E'    when new.payment_mode in (''Cash'', ''Bank'', ''Cheque'') then jsonb_build_object(\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: journal_on_expense credit anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'    -- 0542: a float card bill comes off the card''s own ledger account.\n'
      || E'    when new.payment_mode = ''Card'' then jsonb_build_object(\n'
      || E'      ''account_id'', (select fc.coa_account_id from public.fuel_cards fc\n'
      || E'                      where fc.id = new.fuel_card_id and fc.role = ''float''),\n'
      || E'      ''debit'', 0, ''credit'', new.amount)\n'
      || v_a);
    execute v_src;
  end if;

  -- ── 6. the six cash-basis readers: a card bill is cash out on its date ──────
  foreach v_fn in array array[
    'public.client_statement_loaded(date,date,text,uuid)', 'public.ho_pool(uuid,date,date,text)',
    'public.regional_pl_range(date,date,uuid)', 'public.statement_tieout(uuid,date)',
    'public.unplaced_money(uuid,date)'] loop
    v_src := pg_get_functiondef(v_fn::regprocedure);
    if position('''Cash'',''Bank'',''Card''' in v_src) = 0 then
      v_a := 'payment_mode in (''Cash'',''Bank'') then';
      v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
      if v_cnt <> 1 then raise exception '0542 REFUSED: % cash-date anchor found % times.', v_fn, v_cnt; end if;
      v_src := replace(v_src, v_a, 'payment_mode in (''Cash'',''Bank'',''Card'') /* 0542 */ then');
      execute v_src;
    end if;
  end loop;
  -- regional_cash_hunger: its arguments are looked up, not assumed
  select p.oid::regprocedure::text into v_fn from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'regional_cash_hunger';
  v_src := pg_get_functiondef(v_fn::regprocedure);
  if position('''Cash'',''Bank'',''Card''' in v_src) = 0 then
    v_a := 'payment_mode in (''Cash'',''Bank'') then';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: regional_cash_hunger cash-date anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, 'payment_mode in (''Cash'',''Bank'',''Card'') /* 0542 */ then');
    execute v_src;
  end if;

  -- ── 7. disburse_payslip: the card channel ───────────────────────────────────
  v_src := pg_get_functiondef('public.disburse_payslip(uuid,numeric,numeric,text,uuid,uuid,uuid,timestamptz,text)'::regprocedure);
  if position('0542' in v_src) = 0 then
    v_a := E'p_description text)\n RETURNS void';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip header anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, E'p_description text, p_fuel_card_id uuid DEFAULT NULL::uuid)\n RETURNS void');

    v_a := E'  select company_id, net_salary into v_company, v_net\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip guard anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  -- 0542: the card channel. An ALLOWANCE card held by this payslip''s man,\n'
      || E'  -- and the bank that loads it — the money leaves that bank.\n'
      || E'  if p_fuel_card_id is not null then\n'
      || E'    perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id));\n'
      || E'  end if;\n'
      || E'  if p_payment_mode = ''Card'' then\n'
      || E'    if p_bank_account_id is null then\n'
      || E'      raise exception ''Choose the bank that loads the card. Nothing has been paid.'' using errcode = ''P0001'';\n'
      || E'    end if;\n'
      || E'    if not exists (select 1 from public.fuel_cards fc join public.payslips p on p.id = p_payslip_id\n'
      || E'                    where fc.id = p_fuel_card_id and fc.role = ''allowance'' and fc.is_active\n'
      || E'                      and fc.holder_employee_id = p.employee_id) then\n'
      || E'      raise exception ''Pay a card only onto an active allowance card held by this employee. Nothing has been paid.'' using errcode = ''P0001'';\n'
      || E'    end if;\n'
      || E'  end if;\n\n'
      || v_a);

    v_a := E'    bank_account_id       = case when p_payment_mode in (''Bank'',''Cheque'') then p_bank_account_id else null end,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip bank anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'    bank_account_id       = case when p_payment_mode in (''Bank'',''Cheque'',''Card'') then p_bank_account_id else null end,\n'
      || E'    fuel_card_id          = case when p_payment_mode = ''Card'' then p_fuel_card_id else null end,\n');

    -- 0541's part: it names the card too
    v_a := E'      (company_id, payslip_id, amount, paid_at, payment_mode, bank_account_id, cheque_id, custodian_location_id, description)\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip part-columns anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'      (company_id, payslip_id, amount, paid_at, payment_mode, bank_account_id, cheque_id, custodian_location_id, description, fuel_card_id)\n');
    v_a := E'            case when p_payment_mode in (''Bank'', ''Cheque'') then p_bank_account_id end,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip part-bank anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, E'            case when p_payment_mode in (''Bank'', ''Cheque'', ''Card'') then p_bank_account_id end,\n');
    v_a := E'            p_description);\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip part-values anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, E'            p_description, case when p_payment_mode = ''Card'' then p_fuel_card_id end);\n');

    v_a := E'    v_company,\n    p_payment_mode,\n    p_bank_account_id,\n    -v_pay,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: disburse_payslip money anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'    v_company,\n    case when p_payment_mode = ''Card'' then ''Bank'' else p_payment_mode end,   -- 0542: a card is loaded from the bank\n    p_bank_account_id,\n    -v_pay,\n');

    drop function public.disburse_payslip(uuid, numeric, numeric, text, uuid, uuid, uuid, timestamptz, text);
    execute v_src;
    revoke all on function public.disburse_payslip(uuid, numeric, numeric, text, uuid, uuid, uuid, timestamptz, text, uuid) from public, anon;
    grant execute on function public.disburse_payslip(uuid, numeric, numeric, text, uuid, uuid, uuid, timestamptz, text, uuid) to authenticated, service_role;
  end if;

  -- reverse_payslip_disbursement: name the bank a card part goes back to
  v_src := pg_get_functiondef('public.reverse_payslip_disbursement(uuid,text,boolean,text)'::regprocedure);
  if position('0542' in v_src) = 0 then
    v_a := E'    when ''Cash'' then coalesce((select name from public.cash_locations where id = ps.custodian_location_id), ''cash in hand'')\r\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: reverse where anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a
      || E'    when ''Card'' then coalesce((select bank_name || '' '' || account_number from public.bank_accounts where id = ps.bank_account_id), ''the bank'')   -- 0542\r\n');
    execute v_src;
  end if;

  -- ── 8. the RPCs ─────────────────────────────────────────────────────────────
  execute $fn$
  create or replace function public.fuel_cards_account(p_company_id uuid)
  returns uuid language plpgsql security definer set search_path to 'public'
  as $body$
  declare v_id uuid;
  begin
    -- tenant guard [claimed]: p_company_id IS the caller's tenant claim (0542)
    if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
    v_id := public.coa_id(p_company_id, 'fuel_cards');
    if v_id is null then
      insert into public.chart_of_accounts
        (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, active, is_control, notes)
      values (p_company_id, '1020', 'Fuel Cards', 'asset', 'debit', 'fuel_cards', true, true, true,
              'Company float held on fuel cards; one 1020.NN leaf per card. 0542.')
      returning id into v_id;
    end if;
    return v_id;
  end $body$
  $fn$;
  revoke all on function public.fuel_cards_account(uuid) from public, anon, authenticated;

  execute $fn$
  create or replace function public.register_fuel_card(
    p_role text, p_label text, p_branch_id uuid default null, p_holder_employee_id uuid default null,
    p_card_last4 text default null, p_provider text default 'Attock', p_notes text default null)
  returns uuid language plpgsql security definer set search_path to 'public'
  as $body$
  declare v_company uuid; v_parent uuid; v_acct uuid; v_code text; v_id uuid;
  begin
    -- 0542: a float card is company money (accounting.edit); an allowance card
    -- is where a man is paid (payroll.edit).
    if p_role not in ('float', 'allowance') then raise exception 'A fuel card is either a company float or an allowance card. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if auth.uid() is not null and pg_trigger_depth() = 0 then
      perform public.require_perm(case when p_role = 'float' then 'accounting.edit' else 'payroll.edit' end);
    end if;
    perform public.assert_branch_in_company(p_branch_id);
    perform public.assert_branch_writable(p_branch_id);
    -- tenant guard [resolved]: owning company from p_holder_employee_id via public.employees
    if p_holder_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_holder_employee_id)); end if;

    v_company := public.current_company_id();
    if v_company is null then
      v_company := coalesce((select company_id from public.branches where id = p_branch_id),
                            (select company_id from public.employees where id = p_holder_employee_id));
    end if;
    if v_company is null then raise exception 'No company to register the card under. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_label is null or btrim(p_label) = '' then
      raise exception 'Name the card (e.g. "Office bike — Zafar"). Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_role = 'allowance' and p_holder_employee_id is null then
      raise exception 'An allowance card belongs to a man: choose who holds it. Nothing has been recorded.' using errcode = 'P0001';
    end if;

    if p_role = 'float' then
      v_parent := public.fuel_cards_account(v_company);
      select '1020.' || lpad((coalesce(max(nullif(split_part(account_code, '.', 2), '')::int), 0) + 1)::text, 2, '0')
        into v_code
        from public.chart_of_accounts where company_id = v_company and account_code like '1020.%';
      insert into public.chart_of_accounts
        (company_id, account_code, account_name, account_type, normal_side, parent_id, system_account, active, is_control, notes)
      values (v_company, v_code, 'Fuel card — ' || btrim(p_label), 'asset', 'debit', v_parent, false, true, false,
              'Float on one fuel card; its balance is this account. 0542.')
      returning id into v_acct;
    end if;

    insert into public.fuel_cards (company_id, role, label, provider, card_last4, holder_employee_id, branch_id, coa_account_id, notes)
    values (v_company, p_role, btrim(p_label), coalesce(nullif(btrim(p_provider), ''), 'Attock'),
            nullif(btrim(p_card_last4), ''), p_holder_employee_id, p_branch_id, v_acct, nullif(btrim(p_notes), ''))
    returning id into v_id;
    return v_id;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.set_fuel_card_active(p_fuel_card_id uuid, p_active boolean)
  returns void language plpgsql security definer set search_path to 'public'
  as $body$
  declare c public.fuel_cards; v_n int;
  begin
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null then raise exception 'That card does not exist.' using errcode = 'P0001'; end if;
    if auth.uid() is not null and pg_trigger_depth() = 0 then
      perform public.require_perm(case when c.role = 'float' then 'accounting.edit' else 'payroll.edit' end);
    end if;
    perform public.assert_branch_writable(c.branch_id);
    if not p_active and c.role = 'float'
       and abs(coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl where jl.account_id = c.coa_account_id), 0)) > 0.005 then
      raise exception 'This card still holds a balance. Spend or move it before retiring the card.' using errcode = 'P0001';
    end if;
    update public.fuel_cards set is_active = p_active, updated_at = now() where id = c.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The card could not be updated.' using errcode = 'P0001'; end if;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.load_fuel_card(
    p_fuel_card_id uuid, p_bank_account_id uuid, p_amount numeric, p_loaded_on date, p_note text default null)
  returns uuid language plpgsql security definer set search_path to 'public'
  as $body$
  declare c public.fuel_cards; v_bank_company uuid; v_id uuid; v_desc text; v_je uuid;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    -- tenant guard [resolved]: owning company from p_bank_account_id via public.bank_accounts
    if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;

    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' or not c.is_active then
      raise exception 'Only an active company float card is loaded here. An allowance is paid onto a card from payroll. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    perform public.assert_branch_writable(c.branch_id);
    select company_id into v_bank_company from public.bank_accounts where id = p_bank_account_id;
    if v_bank_company is distinct from c.company_id then
      raise exception 'Choose the bank the card is loaded from. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_amount is null or p_amount <= 0 then raise exception 'The load must be more than zero. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_loaded_on is null then raise exception 'Enter the date the card was loaded. Nothing has been recorded.' using errcode = 'P0001'; end if;

    insert into public.fuel_card_loads (company_id, fuel_card_id, bank_account_id, amount, loaded_on, note)
    values (c.company_id, c.id, p_bank_account_id, round(p_amount, 2), p_loaded_on, nullif(btrim(p_note), ''))
    returning id into v_id;

    v_desc := 'Fuel card loaded — ' || c.label || coalesce(' · ' || nullif(btrim(p_note), ''), '');
    perform public.apply_money_delta(c.company_id, 'Bank', p_bank_account_id, -round(p_amount, 2), 'fuel_card', v_desc, v_id::text);
    v_je := public.post_journal(c.company_id, p_loaded_on, v_desc, 'fuel_card_loads', v_id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', c.coa_account_id, 'debit', round(p_amount, 2), 'credit', 0),
        jsonb_build_object('account_id', public.bank_account_gl(c.company_id, p_bank_account_id), 'debit', 0, 'credit', round(p_amount, 2))),
      c.branch_id);
    update public.fuel_card_loads set journal_id = v_je where id = v_id;
    return v_id;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.reverse_fuel_card_load(p_load_id uuid, p_reason text)
  returns void language plpgsql security definer set search_path to 'public'
  as $body$
  declare l public.fuel_card_loads; c public.fuel_cards; v_bal numeric; v_n int;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_load_id via public.fuel_card_loads
    if p_load_id is not null then perform public.assert_same_company((select company_id from public.fuel_card_loads where id = p_load_id)); end if;
    if length(btrim(coalesce(p_reason, ''))) < 5 then
      raise exception 'Say why this load is being reversed (a few words at least).' using errcode = 'P0001';
    end if;
    select * into l from public.fuel_card_loads where id = p_load_id for update;
    if l.id is null then raise exception 'That load does not exist.' using errcode = 'P0001'; end if;
    select * into c from public.fuel_cards where id = l.fuel_card_id;
    perform public.assert_branch_writable(c.branch_id);
    select coalesce(sum(jl.debit - jl.credit), 0) into v_bal from public.journal_lines jl where jl.account_id = c.coa_account_id;
    if v_bal < l.amount - 0.005 then
      raise exception 'The card holds PKR % — less than this load of PKR %, so part of it has been spent. Reverse the bills first.',
        to_char(v_bal, 'FM999,999,990'), to_char(l.amount, 'FM999,999,990') using errcode = 'P0001';
    end if;
    perform public.apply_money_delta(l.company_id, 'Bank', l.bank_account_id, l.amount, 'fuel_card',
      'Fuel card load reversed — ' || c.label || ' · ' || btrim(p_reason), l.id::text);
    perform public.reverse_journal_for_source(l.company_id, 'fuel_card_loads', l.id, l.loaded_on);
    delete from public.fuel_card_loads where id = l.id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'The load could not be reversed.' using errcode = 'P0001'; end if;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.record_fuel_card_bill(
    p_fuel_card_id uuid, p_amount numeric, p_bill_date date, p_category_id uuid,
    p_client_id uuid default null, p_branch_id uuid default null, p_description text default null)
  returns uuid language plpgsql security definer set search_path to 'public'
  as $body$
  declare c public.fuel_cards; v_bal numeric; v_branch uuid; v_id uuid;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('expenses.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    if p_category_id is not null then perform public.assert_same_company((select company_id from public.expense_categories where id = p_category_id)); end if;
    if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;

    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' or not c.is_active then
      raise exception 'A bill comes off an active company float card. An allowance card''s spending is the man''s own. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    perform public.assert_branch_in_company(p_branch_id);
    v_branch := coalesce(p_branch_id, c.branch_id);
    perform public.assert_branch_in_company(v_branch);
    perform public.assert_branch_writable(v_branch);
    if p_amount is null or p_amount <= 0 then raise exception 'The bill must be more than zero. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_bill_date is null then raise exception 'Enter the date of the bill. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_category_id is null then raise exception 'Choose the expense category. Nothing has been recorded.' using errcode = 'P0001'; end if;

    -- The card cannot spend what it does not hold. Bastion's balance, as of the bill.
    select coalesce(sum(jl.debit - jl.credit), 0) into v_bal
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where jl.account_id = c.coa_account_id and je.entry_date <= p_bill_date;
    if round(p_amount, 2) > v_bal + 0.005 then
      raise exception 'This card holds PKR % on %, less than the bill of PKR %. Record the load first. Nothing has been recorded.',
        to_char(v_bal, 'FM999,999,990'), p_bill_date, to_char(p_amount, 'FM999,999,990') using errcode = 'P0001';
    end if;

    insert into public.expenses (
      company_id, category_id, pl_category, client_id, branch_id, description, amount, expense_date, payment_mode, fuel_card_id)
    values (
      c.company_id, p_category_id,
      (case when p_client_id is not null then 'cost_of_services' else 'operating_expense' end)::public.expense_pl_category,
      p_client_id, v_branch, coalesce(nullif(btrim(p_description), ''), 'Fuel — ' || c.label),
      round(p_amount, 2), p_bill_date, 'Card', c.id)
    returning id into v_id;
    -- No apply_money_delta: no bank or cash balance moves. The card's balance is
    -- its ledger account, and journal_on_expense has just credited it.
    return v_id;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.record_fuel_card_reading(
    p_fuel_card_id uuid, p_as_of date, p_portal_balance numeric, p_note text default null)
  returns uuid language plpgsql security definer set search_path to 'public'
  as $body$
  declare c public.fuel_cards; v_id uuid;
  begin
    if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
    -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
    if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
    select * into c from public.fuel_cards where id = p_fuel_card_id;
    if c.id is null or c.role <> 'float' then
      raise exception 'The Attock figure is checked for company float cards only.' using errcode = 'P0001';
    end if;
    perform public.assert_branch_writable(c.branch_id);
    if p_as_of is null or p_as_of > current_date then raise exception 'Enter the date the portal showed this balance (not in the future).' using errcode = 'P0001'; end if;
    if p_portal_balance is null then raise exception 'Enter the balance the portal shows.' using errcode = 'P0001'; end if;
    insert into public.fuel_card_readings (company_id, fuel_card_id, as_of, portal_balance, note)
    values (c.company_id, c.id, p_as_of, round(p_portal_balance, 2), nullif(btrim(p_note), ''))
    returning id into v_id;
    return v_id;
  end $body$
  $fn$;

  -- ── 9. reading the cards, and the check ─────────────────────────────────────
  execute $fn$
  create or replace function public.fuel_card_balances(p_company_id uuid)
  returns table(fuel_card_id uuid, role text, label text, provider text, card_last4 text,
                holder_employee_id uuid, holder_name text, branch_id uuid, account_code text, is_active boolean,
                balance numeric, loaded numeric, billed numeric,
                reading_as_of date, portal_balance numeric, balance_on_reading numeric, difference numeric)
  language plpgsql stable security definer set search_path to 'public'
  as $body$
  #variable_conflict use_column
  begin
    -- tenant guard [claimed]: p_company_id IS the caller's tenant claim (0542)
    if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
    return query
    with lr as (
      select distinct on (r.fuel_card_id) r.fuel_card_id, r.as_of, r.portal_balance
        from public.fuel_card_readings r where r.company_id = p_company_id
       order by r.fuel_card_id, r.as_of desc, r.created_at desc
    )
    select fc.id, fc.role, fc.label, fc.provider, fc.card_last4, fc.holder_employee_id, e.full_name, fc.branch_id,
           a.account_code, fc.is_active,
           round(coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl where jl.account_id = fc.coa_account_id), 0), 2),
           round(coalesce((select sum(l.amount) from public.fuel_card_loads l where l.fuel_card_id = fc.id), 0), 2),
           round(coalesce((select sum(x.amount) from public.expenses x where x.fuel_card_id = fc.id and x.payment_mode = 'Card'), 0), 2),
           lr.as_of, lr.portal_balance,
           case when lr.as_of is not null then round(coalesce((
             select sum(jl.debit - jl.credit) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
              where jl.account_id = fc.coa_account_id and je.entry_date <= lr.as_of), 0), 2) end,
           case when lr.as_of is not null then round(lr.portal_balance - coalesce((
             select sum(jl.debit - jl.credit) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
              where jl.account_id = fc.coa_account_id and je.entry_date <= lr.as_of), 0), 2) end
      from public.fuel_cards fc
      left join public.employees e on e.id = fc.holder_employee_id
      left join public.chart_of_accounts a on a.id = fc.coa_account_id
      left join lr on lr.fuel_card_id = fc.id
     where fc.company_id = p_company_id
     order by fc.role, fc.is_active desc, fc.label;
  end $body$
  $fn$;

  execute $fn$
  create or replace function public.fuel_card_portal_gaps(p_company_id uuid)
  returns table(fuel_card_id uuid, label text, problem text, bastion numeric, portal numeric)
  language plpgsql stable security definer set search_path to 'public'
  as $body$
  #variable_conflict use_column
  begin
    -- tenant guard [claimed]: p_company_id IS the caller's tenant claim (0542)
    if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
    -- 0542. A float card is wrong when the portal disagrees with Bastion on the
    -- date it was read, when it has never been read (a card nobody has checked
    -- is not evidence of anything), or when Bastion holds it below zero.
    return query
    select b.fuel_card_id, b.label,
           case when b.balance < -0.005 then 'Bastion holds this card below zero'
                when b.reading_as_of is null then 'No Attock portal balance has been entered for this card'
                else 'Attock shows ' || to_char(b.portal_balance, 'FM999,999,990') || ' on ' || b.reading_as_of
                     || '; Bastion holds ' || to_char(b.balance_on_reading, 'FM999,999,990') end,
           coalesce(b.balance_on_reading, b.balance), b.portal_balance
      from public.fuel_card_balances(p_company_id) b
     where b.role = 'float' and b.is_active
       and (b.balance < -0.005 or b.reading_as_of is null or abs(b.difference) > 0.5);
  end $body$
  $fn$;

  v_src := pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure);
  if position('fuel_cards_agree_with_attock_portal' in v_src) = 0 then
    v_a := E'    select ''no_definer_function_crosses_a_branch''::text,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: ledger_checks insertion anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'    -- 0542. A float card''s balance is Bastion''s word against the Attock\n'
      || E'    -- portal''s. Red when they differ on the date read, when a card was never\n'
      || E'    -- read, or when Bastion holds one below zero.\n'
      || E'    select ''fuel_cards_agree_with_attock_portal''::text,\n'
      || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
      || E'      from public.fuel_card_portal_gaps(p_company_id)\n'
      || E'    union all\n'
      || v_a);
    v_a := E'(select 46::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1)';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0542 REFUSED: canary anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'(select 47::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1, 0542: +1)');
    execute v_src;
  end if;

  -- grants for the new functions: authenticated callers; the account helper stays private
  foreach v_fn in array array[
    'public.register_fuel_card(text,text,uuid,uuid,text,text,text)', 'public.set_fuel_card_active(uuid,boolean)',
    'public.load_fuel_card(uuid,uuid,numeric,date,text)', 'public.reverse_fuel_card_load(uuid,text)',
    'public.record_fuel_card_bill(uuid,numeric,date,uuid,uuid,uuid,text)', 'public.record_fuel_card_reading(uuid,date,numeric,text)',
    'public.fuel_card_balances(uuid)', 'public.fuel_card_portal_gaps(uuid)'] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;

  -- ── asserts ─────────────────────────────────────────────────────────────────
  select sum(direct_expenses) into v_after
    from public.client_statement_loaded('2026-09-01', '2026-09-30', 'cash', v_co);
  if v_after is distinct from v_before then
    raise exception '0542 REFUSED: September direct expenses moved from % to % with no card bill on record.', v_before, v_after;
  end if;

  -- the canary, from its own row
  if not (select passed from public.ledger_checks(v_co) where check_name = 'checks_evaluated') then
    raise exception '0542 REFUSED: checks_evaluated disagrees with itself after adding fuel_cards_agree_with_attock_portal.';
  end if;
  if not exists (select 1 from public.ledger_checks(v_co) where check_name = 'fuel_cards_agree_with_attock_portal' and passed) then
    raise exception '0542 REFUSED: the Attock check is missing, or red with no card on record.';
  end if;

  -- no guard gaps on anything this migration wrote
  if exists (select 1 from public.tenant_guard_gaps()
              where function_name in ('register_fuel_card', 'set_fuel_card_active', 'load_fuel_card', 'reverse_fuel_card_load',
                                      'record_fuel_card_bill', 'record_fuel_card_reading', 'fuel_card_balances',
                                      'fuel_card_portal_gaps', 'fuel_cards_account', 'disburse_payslip')) then
    raise exception '0542 REFUSED: tenant_guard_gaps names a function this migration wrote.';
  end if;
  if exists (select 1 from public.branch_guard_gaps() g
              where g.shape = 'writes' and not (g.function_name || '/' || g.subject = any (v_gaps_before))) then
    raise exception '0542 REFUSED: this migration opened a branch-guard gap: %.',
      (select string_agg(g.function_name || '/' || g.subject, ', ') from public.branch_guard_gaps() g
        where g.shape = 'writes' and not (g.function_name || '/' || g.subject = any (v_gaps_before)));
  end if;

  -- (1) + (2): a float card, loaded and billed, rolled back
  select b.id into v_bank from public.bank_accounts b where b.company_id = v_co order by b.balance desc limit 1;
  select ec.id into v_cat from public.expense_categories ec where ec.company_id = v_co and ec.name = 'Transportation & Fuel' limit 1;
  select br.id into v_br from public.branches br where br.company_id = v_co and br.name = 'ISB/RWP';
  select c.id into v_cl from public.clients c where c.company_id = v_co and c.name = 'Emaar DHA ISB';
  select id into v_emp from public.employees where company_id = v_co and full_name = 'Shayan Ahmed' and category = 'office_staff';
  select p.id into v_ps from public.payslips p where p.employee_id = v_emp and p.period_month = '2026-09-01' and not p.disbursed;
  if v_bank is null or v_cat is null or v_br is null or v_emp is null or v_ps is null or v_cl is null then
    raise exception '0542 REFUSED: proof fixtures missing (bank %, category %, branch %, employee %, payslip %, client %).', v_bank, v_cat, v_br, v_emp, v_ps, v_cl;
  end if;

  begin
    select balance into v_bal0 from public.bank_accounts where id = v_bank;
    select coalesce(sum(direct_expenses), 0) into v_t0
      from public.client_statement_loaded('2026-10-01', '2026-10-31', 'cash', v_co) where client_id = v_cl;
    v_card := public.register_fuel_card('float', '0542 proof card', v_br);
    perform public.load_fuel_card(v_card, v_bank, 10000, '2026-10-10', 'proof');
    perform public.record_fuel_card_bill(v_card, 2500, '2026-10-20', v_cat, v_cl, v_br, 'proof bill');
    select balance into v_bal1 from public.bank_accounts where id = v_bank;
    select b.balance into v_gl from public.fuel_card_balances(v_co) b where b.fuel_card_id = v_card;
    select coalesce(sum(direct_expenses), 0) into v_t1
      from public.client_statement_loaded('2026-10-01', '2026-10-31', 'cash', v_co) where client_id = v_cl;
    if v_gl <> 7500 or v_bal0 - v_bal1 <> 10000 or abs((v_t1 - v_t0) - 2500) > 0.05 then
      raise exception '0542 REFUSED: card holds % (want 7,500), bank fell % (want 10,000), statement cost rose % (want 2,500 — the bill, not the load).',
        v_gl, v_bal0 - v_bal1, v_t1 - v_t0;
    end if;
    begin
      perform public.record_fuel_card_bill(v_card, 9000, '2026-10-21', v_cat, v_cl, v_br, 'too much');
      raise exception '0542 REFUSED: a bill beyond the card''s balance was accepted.';
    exception when others then
      if sqlerrm not like 'This card holds PKR 7,500 on 2026-10-21, less than the bill of PKR 9,000.%' then raise; end if;
    end;
    raise exception '0542-SENTINEL-FLOAT';
  exception when others then
    if sqlerrm <> '0542-SENTINEL-FLOAT' then raise; end if;
  end;

  -- (3): an allowance paid onto a card, rolled back
  begin
    select p.bank_account_id into v_bank from public.payslips p where p.id = v_ps;
    v_acard := public.register_fuel_card('allowance', '0542 proof allowance card', null, v_emp);
    perform public.disburse_payslip(v_ps, 114500, 129500, 'Card', v_bank, null, null,
                                    '2026-10-22 12:00+05', '0542 proof', v_acard);
    select sum(jl.credit) into v_bank_cr
      from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
     where je.source_table = 'payslips_disbursement' and je.source_id = v_ps and not je.is_reversal
       and jl.account_id = public.bank_account_gl(v_co, v_bank);
    if v_bank_cr <> 129500 or (select payment_mode from public.payslips where id = v_ps) <> 'Card' then
      raise exception '0542 REFUSED: an allowance paid onto a card credited the bank % (want 129,500 — 114,500 bank + 15,000 card loaded from it).', v_bank_cr;
    end if;
    raise exception '0542-SENTINEL-ALLOWANCE';
  exception when others then
    if sqlerrm <> '0542-SENTINEL-ALLOWANCE' then raise; end if;
  end;
  if exists (select 1 from public.fuel_cards) then
    raise exception '0542 REFUSED: a proof card survived its rollback.';
  end if;

  raise notice '0542: float proved (load 10,000 / bill 2,500 / holds 7,500), allowance onto card proved, canary passed.';
end $mig$;
