-- 0541 — a payslip paid in parts settles each part where it left
--
-- Found 2026-10-22 building fuel cards (DECIDED 2026-10-16: a fixed allowance
-- is an earning line with its own disbursement channel — Shayan's 100,000 to
-- the bank and 30,000 to his fuel card, or 15,000/15,000 with cash).
--
-- A payslip can already be paid in parts: disburse_payslip moves the delta
-- between what was paid and what is now paid, through whatever channel the
-- caller names. But the payslip keeps ONE channel — the last one — and so:
--   * post_payslip_disbursement credited the WHOLE net to the last channel's
--     account. Paid 114,500 by bank and 15,000 in cash, the ledger said
--     129,500 left the bank and nothing left the custodian. Both balances are
--     then wrong by 15,000, and bank_held_operational and the custodian float
--     disagree with their own movements.
--   * reverse_payslip_disbursement returned the whole amount to the last
--     channel, moving money that never came from there.
-- Nothing raised. A split payment was a silent mis-posting.
--
-- The change:
--   1. payslip_payments — one row per movement disburse_payslip makes, signed,
--      naming its channel. Written by disburse_payslip and nothing else.
--   2. disburse_payslip writes the row BEFORE its claim on the payslip, so the
--      journal trigger that the claim fires already sees it. A refused claim
--      raises and takes the row with it.
--   3. post_payslip_disbursement credits each channel what was paid through
--      it. Whatever no recorded part explains — every payslip paid before this
--      migration — settles through the payslip's own channel exactly as before,
--      so no existing entry changes and every entry still balances.
--   4. reverse_payslip_disbursement gives each part back to the channel it
--      left by, and refuses 'recover' for a payslip paid through more than one
--      (one advance cannot name two channels).
-- One payslip is partly paid today (Shayan, September: 114,500 of 129,500 by
-- bank). Its part is recorded from the payslip as it stands, which the bank
-- movement of 15 October confirms.
--
-- DEFERRED: the disbursement posts on one date (disbursed_at) for every part,
-- as the cash-basis statements read it. If parts paid in different months
-- must land in their own months, the change is one journal entry per
-- payslip_payments row, and the statements reading payslip_payments.paid_at.
--
-- Every function amended here has more than one author: surgery against the
-- live definition, each anchor asserted to appear exactly once.
--
-- Asserted on the thing that can break: Shayan's September payslip, finished
-- in cash inside a block rolled back by a sentinel, posts TWO credits — the
-- bank 114,500 and the custodian 15,000 — and the entry balances. A single
-- credit of 129,500 to the bank, the old behaviour, fails it.

do $mig$
declare
  v_src text; v_cnt int; v_a text;
  v_ps uuid; v_bank uuid; v_loc uuid; v_co uuid;
  v_bank_gl uuid; v_cash_gl uuid;
  v_n int; v_bank_cr numeric; v_cash_cr numeric; v_dr numeric; v_cr numeric;
begin
  -- ── 1. the parts ────────────────────────────────────────────────────────────
  create table if not exists public.payslip_payments (
    id                    uuid primary key default gen_random_uuid(),
    company_id            uuid not null references public.companies(id),
    payslip_id            uuid not null references public.payslips(id) on delete cascade,
    amount                numeric(14,2) not null check (amount <> 0),
    paid_at               timestamptz not null,
    payment_mode          text not null check (payment_mode in ('Cash', 'Bank', 'Cheque')),
    bank_account_id       uuid references public.bank_accounts(id),
    cheque_id             uuid references public.cheques(id),
    custodian_location_id uuid references public.cash_locations(id),
    description           text,
    created_at            timestamptz not null default now(),
    created_by            uuid default auth.uid(),
    constraint payslip_payment_names_its_channel check (
      (payment_mode <> 'Bank' or bank_account_id is not null)
      and (payment_mode <> 'Cash' or custodian_location_id is not null))
  );
  create index if not exists payslip_payments_payslip_idx on public.payslip_payments (payslip_id);
  comment on table public.payslip_payments is
    '0541. One row per movement disburse_payslip makes on a payslip, signed, naming the channel it went through. '
    'post_payslip_disbursement credits each channel its own sum; reverse_payslip_disbursement returns each part to it. '
    'Written only by disburse_payslip — no write policy exists.';

  alter table public.payslip_payments enable row level security;
  -- Visible exactly when its payslip is: the payslip's own policies decide.
  drop policy if exists payslip_payments_read on public.payslip_payments;
  create policy payslip_payments_read on public.payslip_payments for select to authenticated
    using (exists (select 1 from public.payslips p where p.id = payslip_id));
  revoke all on public.payslip_payments from anon;
  grant select on public.payslip_payments to authenticated;

  -- The one payslip partly paid before this: record its part as it stands.
  insert into public.payslip_payments
    (company_id, payslip_id, amount, paid_at, payment_mode, bank_account_id, cheque_id, custodian_location_id, description)
  select p.company_id, p.id, round(p.amount_paid), p.updated_at, p.payment_mode,
         case when p.payment_mode in ('Bank', 'Cheque') then p.bank_account_id end,
         case when p.payment_mode = 'Cheque' then p.cheque_id end,
         case when p.payment_mode = 'Cash' then p.custodian_location_id end,
         '0541: paid before parts were recorded; channel as the payslip stood'
    from public.payslips p
   where coalesce(p.amount_paid, 0) > 0 and not p.disbursed
     and not exists (select 1 from public.payslip_payments pm where pm.payslip_id = p.id);

  -- ── 2. disburse_payslip records the part before it claims ───────────────────
  v_src := pg_get_functiondef('public.disburse_payslip(uuid,numeric,numeric,text,uuid,uuid,uuid,timestamptz,text)'::regprocedure);
  if position('0541' in v_src) = 0 then
    v_a := E'  update public.payslips set\n    amount_paid           = p_target_paid,\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: disburse_payslip claim anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  -- 0541: the part, named by its channel, written BEFORE the claim so the\n'
      || E'  -- journal trigger the claim fires already sees it. A refused claim raises\n'
      || E'  -- and takes this row with it.\n'
      || E'  if round(p_target_paid) - round(p_expected_paid) <> 0 then\n'
      || E'    insert into public.payslip_payments\n'
      || E'      (company_id, payslip_id, amount, paid_at, payment_mode, bank_account_id, cheque_id, custodian_location_id, description)\n'
      || E'    values (v_company, p_payslip_id, round(p_target_paid) - round(p_expected_paid), coalesce(p_disbursed_at, now()),\n'
      || E'            p_payment_mode,\n'
      || E'            case when p_payment_mode in (''Bank'', ''Cheque'') then p_bank_account_id end,\n'
      || E'            case when p_payment_mode = ''Cheque'' then p_cheque_id end,\n'
      || E'            case when p_payment_mode = ''Cash'' then p_custodian_location_id end,\n'
      || E'            p_description);\n'
      || E'  end if;\n\n'
      || v_a);
    execute v_src;
  end if;

  -- ── 3. post_payslip_disbursement: a credit per channel ──────────────────────
  v_src := pg_get_functiondef('public.post_payslip_disbursement(uuid)'::regprocedure);
  if position('0541' in v_src) = 0 then
    v_a := E'  v_dim    jsonb;\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: post declare anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'  pp       record;\n  v_rest   numeric;\n');

    v_a := E'  v_cr := jsonb_build_object(\n'
        || E'    ''account_id'', public.settlement_account(ps.company_id, ps.payment_mode,\n'
        || E'                                            ps.bank_account_id, ps.custodian_location_id, true),\n'
        || E'    ''debit'', 0, ''credit'', ps.net_salary);\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: post credit anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  -- 0541: one credit per channel the payslip was paid through. Whatever no\n'
      || E'  -- recorded part explains (every payslip paid before 0541) settles through\n'
      || E'  -- the payslip''s own channel, exactly as before.\n'
      || E'  v_cr := ''[]''::jsonb;\n'
      || E'  v_rest := ps.net_salary;\n'
      || E'  for pp in\n'
      || E'    select pm.payment_mode, pm.bank_account_id, pm.custodian_location_id, sum(pm.amount) as amt\n'
      || E'      from public.payslip_payments pm where pm.payslip_id = ps.id\n'
      || E'     group by 1, 2, 3 having sum(pm.amount) <> 0\n'
      || E'  loop\n'
      || E'    v_cr := v_cr || jsonb_build_array(v_dim || jsonb_build_object(\n'
      || E'      ''account_id'', public.settlement_account(ps.company_id, pp.payment_mode,\n'
      || E'                                              pp.bank_account_id, pp.custodian_location_id, true),\n'
      || E'      ''debit'', 0, ''credit'', pp.amt));\n'
      || E'    v_rest := v_rest - pp.amt;\n'
      || E'  end loop;\n'
      || E'  if v_rest <> 0 then\n'
      || E'    v_cr := v_cr || jsonb_build_array(v_dim || jsonb_build_object(\n'
      || E'      ''account_id'', public.settlement_account(ps.company_id, ps.payment_mode,\n'
      || E'                                              ps.bank_account_id, ps.custodian_location_id, true),\n'
      || E'      ''debit'', 0, ''credit'', v_rest));\n'
      || E'  end if;\n');

    v_a := E'    ) || jsonb_build_array(v_dim || v_cr),\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: post lines anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, E'    ) || v_cr,\n');
    execute v_src;
  end if;

  -- ── 4. reverse_payslip_disbursement: each part back where it left ───────────
  -- (This function's text carries CRLF line endings; the anchors match them.)
  v_src := pg_get_functiondef('public.reverse_payslip_disbursement(uuid,text,boolean,text)'::regprocedure);
  if position('0541' in v_src) = 0 then
    v_a := E'  v_note    text;\r\n';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: reverse declare anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'  pp        record;\r\n  v_parts   int;\r\n  v_rest    numeric;\r\n');

    -- refusals: 'recover' cannot name two channels; a cheque part that cleared
    v_a := E'  if p_mode = ''recover'' and ps.payment_mode not in (''Cash'', ''Bank'') then';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: reverse recover anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  -- 0541: a payslip paid in parts, through more than one channel.\r\n'
      || E'  select count(distinct (pm.payment_mode, pm.bank_account_id, pm.custodian_location_id)) into v_parts\r\n'
      || E'    from public.payslip_payments pm where pm.payslip_id = ps.id;\r\n'
      || E'  if p_mode = ''recover'' and v_parts > 1 then\r\n'
      || E'    v_b := array_append(v_b, (''It was paid in parts through more than one channel, and one advance cannot name both. Reverse it without recovering, then record the advance.'')::text);\r\n'
      || E'  end if;\r\n'
      || E'  if exists (select 1 from public.payslip_payments pm join public.cheques c on c.id = pm.cheque_id\r\n'
      || E'              where pm.payslip_id = ps.id and c.status = ''cleared''\r\n'
      || E'                and pm.cheque_id is distinct from ps.cheque_id) then\r\n'
      || E'    v_b := array_append(v_b, (''Part of it was paid by a cheque that has cleared. Reverse the cheque clearance first.'')::text);\r\n'
      || E'  end if;\r\n'
      || v_a);

    v_a := E'  elsif v_where is not null and v_paid > 0 then';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: reverse effects anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  elsif v_parts > 1 and v_paid > 0 then\r\n'
      || E'    v_e := array_append(v_e, ((''PKR '' || to_char(v_paid, ''FM999,999,999'') || '' goes back, each part to the channel it was paid through.''))::text);\r\n'
      || v_a);

    v_a := E'  if v_paid > 0 and ps.payment_mode in (''Cash'', ''Bank'') then';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: reverse money anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
         E'  -- 0541: each recorded part goes back to the channel it left by (a fuel\r\n'
      || E'  -- card part, 0542, left from the bank that funded it). Whatever no part\r\n'
      || E'  -- explains goes back through the payslip''s own channel, as before.\r\n'
      || E'  if v_paid > 0 and exists (select 1 from public.payslip_payments pm where pm.payslip_id = ps.id) then\r\n'
      || E'    v_rest := v_paid;\r\n'
      || E'    for pp in\r\n'
      || E'      select pm.payment_mode, pm.bank_account_id, pm.custodian_location_id, sum(pm.amount) as amt\r\n'
      || E'        from public.payslip_payments pm where pm.payslip_id = ps.id\r\n'
      || E'       group by 1, 2, 3 having sum(pm.amount) <> 0\r\n'
      || E'    loop\r\n'
      || E'      v_rest := v_rest - round(pp.amt);\r\n'
      || E'      if pp.payment_mode in (''Cash'', ''Bank'', ''Card'') then\r\n'
      || E'        perform public.apply_money_delta(\r\n'
      || E'          ps.company_id, case when pp.payment_mode = ''Card'' then ''Bank'' else pp.payment_mode end,\r\n'
      || E'          pp.bank_account_id, round(pp.amt), ''payroll'', ''Reversal · '' || v_title,\r\n'
      || E'          case when pp.payment_mode = ''Cash'' then pp.custodian_location_id::text else ps.id::text end);\r\n'
      || E'      end if;\r\n'
      || E'    end loop;\r\n'
      || E'    if v_rest <> 0 and ps.payment_mode in (''Cash'', ''Bank'') then\r\n'
      || E'      perform public.apply_money_delta(\r\n'
      || E'        ps.company_id, ps.payment_mode, ps.bank_account_id, v_rest, ''payroll'', ''Reversal · '' || v_title,\r\n'
      || E'        case when ps.payment_mode = ''Cash'' then ps.custodian_location_id::text else ps.id::text end);\r\n'
      || E'    end if;\r\n'
      || E'  elsif v_paid > 0 and ps.payment_mode in (''Cash'', ''Bank'') then');

    -- the parts are gone with the payment they made up
    v_a := E'  update public.payroll_adjustments\r\n     set status = ''open''';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0541 REFUSED: reverse cleanup anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a,
      E'  delete from public.payslip_payments where payslip_id = ps.id;   -- 0541\r\n\r\n' || v_a);
    execute v_src;
  end if;

  -- ── asserts ─────────────────────────────────────────────────────────────────
  -- The backfill: every partly-paid payslip's parts add up to what it says was paid.
  if exists (select 1 from public.payslips p
              where coalesce(p.amount_paid, 0) > 0 and not p.disbursed
                and round(p.amount_paid) <> coalesce((select sum(pm.amount) from public.payslip_payments pm where pm.payslip_id = p.id), 0)) then
    raise exception '0541 REFUSED: a partly-paid payslip''s recorded parts do not add up to what it says was paid.';
  end if;

  -- The split, proved on Shayan's September payslip and rolled back.
  select p.id, p.bank_account_id, p.company_id into v_ps, v_bank, v_co
    from public.payslips p join public.employees e on e.id = p.employee_id
   where e.full_name = 'Shayan Ahmed' and p.period_month = '2026-09-01' and not p.disbursed and p.payment_mode = 'Bank';
  select cl.id into v_loc from public.cash_locations cl
   where cl.company_id = v_co and cl.custodian_employee_id is not null and cl.is_active is not false
   order by cl.created_at limit 1;
  if v_ps is null or v_loc is null then
    raise exception '0541 REFUSED: the payslip or custodian the split is proved on is not there (payslip %, custodian %).', v_ps, v_loc;
  end if;
  v_bank_gl := public.bank_account_gl(v_co, v_bank);
  v_cash_gl := public.cash_account_for(v_co, v_loc);

  begin
    perform public.disburse_payslip(v_ps, 114500, 129500, 'Cash', null, null, v_loc,
                                    '2026-10-22 12:00+05', '0541 proof');
    select count(*) filter (where jl.credit > 0),
           sum(jl.credit) filter (where jl.account_id = v_bank_gl),
           sum(jl.credit) filter (where jl.account_id = v_cash_gl),
           sum(jl.debit), sum(jl.credit)
      into v_n, v_bank_cr, v_cash_cr, v_dr, v_cr
      from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
     where je.source_table = 'payslips_disbursement' and je.source_id = v_ps and not je.is_reversal;
    if v_n <> 2 or v_bank_cr <> 114500 or v_cash_cr <> 15000 or v_dr <> v_cr then
      raise exception '0541 REFUSED: a split payslip posted % credit(s) — bank %, custodian %, debits % vs credits % (expected 2: 114,500 and 15,000, balanced).',
        v_n, v_bank_cr, v_cash_cr, v_dr, v_cr;
    end if;
    raise exception '0541-SENTINEL';
  exception when others then
    if sqlerrm <> '0541-SENTINEL' then raise; end if;
  end;
  if (select disbursed from public.payslips where id = v_ps) then
    raise exception '0541 REFUSED: the split proof was not rolled back.';
  end if;

  raise notice '0541: split proved on Shayan September — bank 114,500 + custodian 15,000.';
end $mig$;
