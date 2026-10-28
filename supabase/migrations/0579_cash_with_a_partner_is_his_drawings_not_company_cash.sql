-- 0579 — cash with a partner is his drawings, not company cash
--
-- DECIDED 2026-10-28 (Shayan): of Shujaat, "everything in his ledger is
-- drawing he doesnt hold company's cash" — asked whether the general ledger
-- should stop counting his custody as company Cash in Hand: "yes" — and then
-- "same remains true for other partners". This answers 0566's DEFERRED
-- question for every partner: Shujaat, Nauman, Shafqat.
--
-- An account with postings cannot be moved out of the Cash tree (the chart
-- guard refuses: a balance must move by an entry). So, the proper way:
--   1. each partner gets a new account under 3000 Owner's Equity, debit side:
--      3000.05 Shujaat / 3000.06 Nauman / 3000.08 Shafqat — "Drawings (cash
--      with him)";
--   2. one entry per partner moves his custody balance there (Dr drawings /
--      Cr his old 1000.0N cash account, dated today);
--   3. his cash location points at the new account, so every later movement —
--      a transfer to him, client cash he collects, an expense he pays for the
--      company — lands in his drawings, with nothing to repeat. The location
--      stays a picker (DECIDED 2026-10-27: partners stay selectable).
--
-- First, a correction found doing it (Shayan: "ok"): Barkat Hussain's
-- September salary, 40,000, was paid 24,000 by Shujaat (6 Oct) and 16,000 by
-- Nauman (8 Oct) — the cash log says so — but the payslip disbursement posted
-- all 40,000 against Nauman. That is the ±24,000 on
-- cash_per_location_gl_equals_operational. One entry moves 24,000 of it:
-- Dr 1000.06 Nauman / Cr 1000.05 Shujaat, dated 7 Oct. Nauman's custody is then
-- −17,100 (lunch 1,100 + Barkat 16,000, owed to him), Shujaat's 2,812,000.
--
-- One check follows: cash_control_equals_cash_locations compared the Cash
-- tree with EVERY non-bank location; it now compares it with the locations
-- whose account IS in the Cash tree (ledger_checks_base, many authors;
-- surgery, anchor once). It adds no check, so the canary is untouched.
--
-- Unchanged: the partner ledgers (they read custody movements, not these
-- accounts); the Cash page (0566 already left partners out of Cash in Hand).
-- Known edge: reversing a custody posting made BEFORE today reverses it on the
-- old 1000.0N account, which then shows a balance — reverse those with care.
--
-- Asserted: Shujaat's and Nauman's custody now agree with their operational
-- cash (the per-location reds fall by two); Cash in Hand control falls by
-- exactly the partners' balances (2,812,000 − 17,100 + 0 = 2,794,900); the
-- cash-control difference is unchanged (274,317, the custodian openings); the
-- trial balance balances; no partner ledger moves.

do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_eq   uuid := (select id from public.chart_of_accounts where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and system_key = 'equity');
  v_slip constant uuid := '26ea9aa2-8e24-42ce-9825-92c1c50aa390';   -- Barkat Hussain, Sep 2026, paid via Nauman
  v_shj_loc constant uuid := 'bfd3c33e-452e-45ae-b083-8744d027f661';
  v_nmn_loc constant uuid := 'eaa714a9-ce5c-47eb-889a-762eb04b268d';
  v_def  text := pg_get_functiondef('public.ledger_checks_base(uuid)'::regprocedure);
  v_anchor constant text := E'    select coalesce(sum(v.balance) filter (where v.location_type <> ''BANK''), 0) bal\n      from public.cash_location_balances v where v.company_id = p_company_id\n';
  v_n int; v_moved numeric := 0; v_ctl0 numeric; v_ctl1 numeric; v_diff0 numeric; v_diff1 numeric; v_tb numeric;
  v_loc0 numeric; v_loc1 numeric; v_led0 jsonb; v_led1 jsonb; r record; v_new uuid; v_bal numeric;
begin
  if v_eq is null then raise exception '0579 REFUSED: 3000 Owner''s Equity not found.'; end if;
  if position('0579' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0579 REFUSED: the cash_locs anchor appears % times in ledger_checks_base.', v_n; end if;

  select actual, difference into v_ctl0, v_diff0 from public.ledger_checks(v_co) where check_name = 'cash_control_equals_cash_locations';
  select actual into v_loc0 from public.ledger_checks(v_co) where check_name = 'cash_per_location_gl_equals_operational';
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  select jsonb_object_agg(p.id, (select sum(l.remuneration - l.cash_paid) from public.partner_ledger(p.id) l))
    into v_led0 from public.partners p where p.company_id = v_co;

  -- ── 1. Barkat Hussain's September salary: 24,000 was Shujaat's cash ─────────
  if (select amount_paid from public.payslips where id = v_slip) <> 40000
     or (select custodian_location_id from public.payslips where id = v_slip) <> v_nmn_loc then
    raise exception '0579 REFUSED: Barkat Hussain''s September payslip is not as recorded.';
  end if;
  perform public.post_journal(v_co, '2026-10-07',
    'Barkat Hussain, September salary: 24,000 of the 40,000 was paid by Shujaat (6 Oct), 16,000 by Nauman (8 Oct) — the disbursement had charged all of it to Nauman',
    'payslip_custody_correction', v_slip, false,
    jsonb_build_array(
      jsonb_build_object('account_id', (select coa_account_id from public.cash_locations where id = v_nmn_loc), 'debit', 24000, 'credit', 0),
      jsonb_build_object('account_id', (select coa_account_id from public.cash_locations where id = v_shj_loc), 'debit', 0, 'credit', 24000)),
    (select branch_id from public.payslips where id = v_slip));

  -- ── 2–3. each partner's custody into his drawings account ──────────────────
  v_n := 0;
  for r in
    select cl.id as loc_id, cl.coa_account_id as old_acct, a.account_code, p.name, cl.branch_id
      from public.cash_locations cl
      join public.partners p on p.id = cl.custodian_partner_id
      join public.chart_of_accounts a on a.id = cl.coa_account_id
     where cl.company_id = v_co and a.account_code like '1000.%'
  loop
    insert into public.chart_of_accounts (company_id, account_code, account_name, account_type, normal_side, parent_id, active, notes)
    values (v_co, '3000.' || split_part(r.account_code, '.', 2), r.name || ' — Drawings (cash with him)', 'equity', 'debit', v_eq, true,
            '0579: cash with a partner is his drawings, not company cash (Shayan, 28 Oct 2026). Takes over from ' || r.account_code || '.')
    returning id into v_new;
    select coalesce(sum(debit - credit), 0) into v_bal from public.journal_lines where account_id = r.old_acct;
    if v_bal <> 0 then
      perform public.post_journal(v_co, '2026-10-28',
        'Cash with ' || r.name || ' is his drawings, not company cash — moved from ' || r.account_code,
        'partner_custody_reclass', r.loc_id, false,
        jsonb_build_array(
          jsonb_build_object('account_id', v_new,      'debit', greatest(v_bal, 0), 'credit', greatest(-v_bal, 0)),
          jsonb_build_object('account_id', r.old_acct, 'debit', greatest(-v_bal, 0), 'credit', greatest(v_bal, 0))),
        r.branch_id);
    end if;
    update public.cash_locations set coa_account_id = v_new where id = r.loc_id;
    update public.chart_of_accounts
       set notes = '0579: retired — ' || r.name || '''s cash is his drawings, now ' || '3000.' || split_part(r.account_code, '.', 2) || '.', updated_at = now()
     where id = r.old_acct;
    v_moved := v_moved + v_bal;
    v_n := v_n + 1;
  end loop;
  if v_n <> 3 then raise exception '0579 REFUSED: % partner cash accounts moved, expected 3 (Shujaat, Nauman, Shafqat).', v_n; end if;

  -- ── the cash check counts the locations whose account is in the Cash tree ──
  execute replace(v_def, v_anchor,
E'    -- 0579: only locations whose account is in the Cash tree — a partner''s\n' ||
E'    -- drawings account (3000.0N) is not company cash.\n' ||
E'    select coalesce(sum(v.balance) filter (where v.location_type <> ''BANK''), 0) bal\n' ||
E'      from public.cash_location_balances v where v.company_id = p_company_id\n' ||
E'       and exists (select 1 from ctl_tree t where t.id = v.coa_account_id and t.root_key = ''cash'')\n');

  -- ── what can break ──────────────────────────────────────────────────────────
  if v_moved <> 2794900 then
    raise exception '0579 REFUSED: the partners'' custody moved was %, expected 2,794,900 (2,812,000 − 17,100 + 0).', v_moved;
  end if;
  select actual, difference into v_ctl1, v_diff1 from public.ledger_checks(v_co) where check_name = 'cash_control_equals_cash_locations';
  if v_ctl0 - v_ctl1 <> v_moved then
    raise exception '0579 REFUSED: Cash in Hand control fell by %, not %.', v_ctl0 - v_ctl1, v_moved;
  end if;
  if v_diff1 is distinct from v_diff0 then
    raise exception '0579 REFUSED: the cash-control difference moved % → %.', v_diff0, v_diff1;
  end if;
  select actual into v_loc1 from public.ledger_checks(v_co) where check_name = 'cash_per_location_gl_equals_operational';
  if v_loc1 <> v_loc0 - 2 then
    raise exception '0579 REFUSED: per-location reds went % → %, expected two fewer (Shujaat, Nauman).', v_loc0, v_loc1;
  end if;
  select difference into v_tb from public.ledger_checks(v_co) where check_name = 'trial_balance_debits_equal_credits';
  if v_tb <> 0 then raise exception '0579 REFUSED: the trial balance is out by %.', v_tb; end if;
  select jsonb_object_agg(p.id, (select sum(l.remuneration - l.cash_paid) from public.partner_ledger(p.id) l))
    into v_led1 from public.partners p where p.company_id = v_co;
  if v_led1 is distinct from v_led0 then
    raise exception '0579 REFUSED: a partner ledger moved (% → %).', v_led0, v_led1;
  end if;
end $mig$;
