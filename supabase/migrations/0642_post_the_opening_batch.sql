-- 0642 — rebuild, redate and post the opening batch.
--
-- Shayan, 4–5 Nov 2026: "post opening balances … do what you think is right";
-- "build". The draft opening batch 9d90fee2 had sat unposted since 3 Sep, and
-- had gone stale:
--
--   * receivables 24,711,339 for 27 clients — today clients.opening_balance is
--     36,746,027 across 34 (Madison's 219,478 added 4 Nov among them);
--   * Gul Rehman's custodian opening (890) but not Shayan's (−275,207);
--   * dated 3 Sep, although the cutover was DECIDED 17 Oct as 31 August 2026
--     with "the opening batch is redated to it" (ledger_cutovers).
--
-- So the GL never held the opening receivable (1100 read about −4.9M, because
-- receipts against openings credited it) nor the custodian openings (the known
-- 274,317 cash-control residual). This migration:
--
--   1. rebuilds the lines from today's figures — one receivable line per client
--      (party and region carried to the GL, as 0521 intends), one line per
--      custodian opening, Opening Balance Equity (3200) balancing;
--   2. dates the batch 31 Aug 2026, the cutover;
--   3. corrects custodian_held_operational (below);
--   4. posts it through post_opening_balances();
--   5. proves that NOTHING anyone looks at moved: every custodian's balance
--      (both the view and the operational/GL pair), every client's receivable
--      balance, and the cash-in-hand figure, before and after — refusing the
--      whole migration on any difference. The one figure meant to move is the
--      GL receivable control, by exactly the client openings.
--
-- WHY custodian_held_operational CHANGES. Once a batch is posted at the cutover
-- (0523), it stops counting custodian movements dated on or before the cutover,
-- treating them as already inside the opening. That assumes the custodian
-- openings are 31 Aug balances. They are not: the cash balances Shayan agreed on
-- 27 Oct ("every cash balance everything aligns as of today") are the opening
-- PLUS every August movement — Shayan's August advances (131,100) and Zafar's
-- August expenses (9,900) included. The openings stand at the start of the
-- ledger, 1 August 2026, the date of the first posted opening batch (0544's bank
-- balances). Posting at 31 Aug without this change would silently drop those
-- August movements and lift cash in hand by 141,000. The boundary becomes the
-- day before the first posted opening batch; no custodian movement exists
-- before 1 Aug, so in practice it counts them all, as it does today.
--
-- The GL side needs nothing: the batch line takes the place of the opening the
-- view and the function added on top of the GL before the batch was posted.
--
-- custodian_held_operational has several authors (0523, 0563, 0566, 0572), so it
-- is changed by surgery against the live text, its anchor asserted once.

set local lock_timeout = '5s';

-- ───────────────────────── One posted opening per company PER DATE ─────────────────────────
-- The first apply was refused by idx_ob_one_posted_per_company: one posted
-- opening batch per company, and 0544 had already posted the bank balances as
-- their own batch at 1 Aug. The client and cash openings belong at the 31 Aug
-- cutover, and ledger_cutover_posted() only recognises a batch dated then.
-- Shayan (named approval, 5 Nov 2026): allow one posted batch per company per
-- date, so 0544's 1 Aug bank batch and this 31 Aug batch both stand.
drop index public.idx_ob_one_posted_per_company;
create unique index idx_ob_one_posted_per_company_date
  on public.opening_balance_batches (company_id, as_of_date) where status = 'posted';
comment on index public.idx_ob_one_posted_per_company_date is
  '0642: at most one posted opening batch per company per date — 0544 posted bank balances at 1 Aug 2026; 0642 posts client receivables and custodian cash at the 31 Aug cutover.';

-- ───────────────────────── Before (no lock held yet) ─────────────────────────
do $before$
declare v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
begin
  if (select cutover_date from public.ledger_cutovers where company_id = v_co) is distinct from date '2026-08-31' then
    raise exception '0642 REFUSED: the cutover is not 31 Aug 2026 — this migration was written for that date.';
  end if;
  if (select status::text from public.opening_balance_batches where id = '9d90fee2-c184-4ca2-8283-018105c415ba') is distinct from 'draft' then
    raise exception '0642 REFUSED: opening batch 9d90fee2 is not a draft.';
  end if;
  if exists (select 1 from public.opening_balance_batches where company_id = v_co and status = 'posted' and as_of_date = date '2026-08-31') then
    raise exception '0642 REFUSED: a batch is already posted at the cutover.';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);

  create temp table b_view on commit drop as
    select cash_location_id, round(balance, 2) as balance from public.cash_location_balances where company_id = v_co;
  create temp table b_ops on commit drop as
    select cash_location_id, operational, gl from public.custodian_held_operational(v_co);
  create temp table b_clients on commit drop as
    select client_id, round(balance, 2) as balance from public.client_receivables_today();
  create temp table b_misc on commit drop as
    select (select held from public.cash_in_hand(v_co) as x(held, opening)) as cash_in_hand,
           (select coalesce(sum(jl.debit - jl.credit), 0) from public.journal_lines jl
             where jl.account_id = (select account_id from public.opening_balance_lines
                                     where batch_id = '9d90fee2-c184-4ca2-8283-018105c415ba' and notes like 'clients.opening_balance%' limit 1)) as gl_ar,
           (select sum(opening_balance) from public.clients where company_id = v_co) as client_openings,
           (select account_id from public.opening_balance_lines
             where batch_id = '9d90fee2-c184-4ca2-8283-018105c415ba' and notes like 'clients.opening_balance%' limit 1) as ar_account,
           (select account_id from public.opening_balance_lines
             where batch_id = '9d90fee2-c184-4ca2-8283-018105c415ba' and notes = 'Balancing entry' limit 1) as equity_account;
  if (select ar_account from b_misc) is null or (select equity_account from b_misc) is null then
    raise exception '0642 REFUSED: could not find the receivable / equity accounts on the draft batch.';
  end if;
  perform set_config('request.jwt.claims', '{}', true);
end
$before$;

-- ───────────────────────── custodian_held_operational: surgery ─────────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.custodian_held_operational(uuid)'::regprocedure);
  a1 constant text := 'v_cut    date    := public.ledger_cutover_date(p_company_id);';
  n int;
begin
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0642 REFUSED: the v_cut anchor in custodian_held_operational appears % times, expected once.', n; end if;
  execute replace(v_def, a1,
    'v_cut    date    := (select min(b.as_of_date) from public.opening_balance_batches b where b.company_id = p_company_id and b.status = ''posted'') - 1;  /* 0642: custodian openings stand at the start of the ledger (the first posted opening, 1 Aug 2026), not the 31 Aug cutover, so movements from then on still count */');
end
$surgery$;

-- ───────────────────────── Rebuild, redate, post ─────────────────────────
do $post$
declare
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_batch constant uuid := '9d90fee2-c184-4ca2-8283-018105c415ba';
  v_ar    uuid := (select ar_account from b_misc);
  v_eq    uuid := (select equity_account from b_misc);
  v_net   numeric;
  v_entry uuid;
begin
  delete from public.opening_balance_lines where batch_id = v_batch;

  -- One receivable line per client, with its party and region.
  insert into public.opening_balance_lines (batch_id, account_id, branch_id, debit, credit, notes, client_id)
  select v_batch, v_ar, c.branch_id,
         greatest(c.opening_balance, 0), greatest(-c.opening_balance, 0),
         'clients.opening_balance — ' || c.name, c.id
    from public.clients c
   where c.company_id = v_co and coalesce(c.opening_balance, 0) <> 0;

  -- One line per custodian opening, on that custodian's own cash account.
  insert into public.opening_balance_lines (batch_id, account_id, branch_id, debit, credit, notes, employee_id)
  select v_batch, l.coa_account_id, l.branch_id,
         greatest(l.opening_balance, 0), greatest(-l.opening_balance, 0),
         'cash_locations.opening_balance — ' || l.name, l.custodian_employee_id
    from public.cash_locations l
   where l.company_id = v_co and coalesce(l.opening_balance, 0) <> 0;
  if exists (select 1 from public.cash_locations l where l.company_id = v_co and coalesce(l.opening_balance, 0) <> 0 and l.coa_account_id is null) then
    raise exception '0642 REFUSED: a custodian with an opening balance has no cash account.';
  end if;

  -- Opening Balance Equity balances it.
  select sum(debit) - sum(credit) into v_net from public.opening_balance_lines where batch_id = v_batch;
  insert into public.opening_balance_lines (batch_id, account_id, branch_id, debit, credit, notes)
  values (v_batch, v_eq, null, greatest(-v_net, 0), greatest(v_net, 0), 'Balancing entry');

  update public.opening_balance_batches
     set as_of_date = date '2026-08-31',
         description = 'Opening trial balance at the 31 Aug 2026 cutover — client receivables and custodian cash (0642; bank balances posted separately by 0544 at 1 Aug)',
         updated_at = now()
   where id = v_batch and status = 'draft';

  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);
  v_entry := public.post_opening_balances(v_batch);
  perform set_config('request.jwt.claims', '{}', true);
  if v_entry is null then raise exception '0642 REFUSED: posting returned no journal entry.'; end if;
end
$post$;

-- ───────────────────────── After: nothing anyone looks at moved ─────────────────────────
do $after$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_n  int;
  v_x  record;
  v_gl_ar numeric;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);

  if not coalesce(public.ledger_cutover_posted(v_co), false) then
    raise exception '0642 REFUSED: the cutover batch is not recognised as posted.';
  end if;

  -- Pairing first: an inner join over nothing passes every comparison below.
  if (select count(*) from b_view) = 0 or (select count(*) from b_ops) = 0 or (select count(*) from b_clients) = 0 then
    raise exception '0642 REFUSED: a before-picture is empty, so nothing below would be tested.';
  end if;

  select count(*) into v_n from b_view b
    full join (select cash_location_id, round(balance, 2) as balance from public.cash_location_balances where company_id = v_co) a
      using (cash_location_id)
   where b.balance is distinct from a.balance;
  if v_n <> 0 then raise exception '0642 REFUSED: % cash location balance(s) changed.', v_n; end if;

  select count(*) into v_n from b_ops b
    full join public.custodian_held_operational(v_co) a using (cash_location_id)
   where b.operational is distinct from a.operational or b.gl is distinct from a.gl;
  if v_n <> 0 then
    select b.cash_location_id, b.operational as op_before, a.operational as op_after, b.gl as gl_before, a.gl as gl_after into v_x
      from b_ops b full join public.custodian_held_operational(v_co) a using (cash_location_id)
     where b.operational is distinct from a.operational or b.gl is distinct from a.gl limit 1;
    raise exception '0642 REFUSED: % custodian figure(s) changed, e.g. %.', v_n, row_to_json(v_x);
  end if;

  select count(*) into v_n from b_clients b
    full join (select client_id, round(balance, 2) as balance from public.client_receivables_today()) a using (client_id)
   where b.balance is distinct from a.balance;
  if v_n <> 0 then raise exception '0642 REFUSED: % client balance(s) changed.', v_n; end if;

  if (select held from public.cash_in_hand(v_co) as x(held, opening)) is distinct from (select cash_in_hand from b_misc) then
    raise exception '0642 REFUSED: cash in hand changed.';
  end if;

  -- The one figure meant to move: the GL receivable control, by exactly the client openings.
  select coalesce(sum(jl.debit - jl.credit), 0) into v_gl_ar from public.journal_lines jl where jl.account_id = (select ar_account from b_misc);
  if v_gl_ar - (select gl_ar from b_misc) <> (select client_openings from b_misc) then
    raise exception '0642 REFUSED: the receivable control moved by %, expected %.', v_gl_ar - (select gl_ar from b_misc), (select client_openings from b_misc);
  end if;

  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0642 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0642 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end
$after$;
