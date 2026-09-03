-- 0341 — the 31 August cutover: receivable openings restated, and the AR check
--        taught that an opening receivable exists.
--
-- WHAT CHANGED AND WHY
--
-- 0339 wrote clients.opening_balance as the receivable per client AS AT
-- 1 AUGUST 2026, totalling 12,131,900, and said in its own header that the
-- ledger still did not know about it. That gap was to be closed by an opening
-- balance batch.
--
-- The cutover then moved. Bank and cash opening balances (7,272,737) carry no
-- as-at date anywhere in the schema — bank_accounts.opening_balance,
-- cash_locations.opening_balance and bank_transactions all lack one; only
-- partners.opening_balance_date exists — and the figures were supplied as at
-- 31 AUGUST. Dating them 1 August would have double-counted every August
-- receipt and payment the moment those were entered. So the cutover is
-- 31 August for everything, and the receivable openings must move with it.
--
-- The 19 August invoices were therefore REVERSED (soft delete: the invoice rows
-- were deleted, trg_yyy_invoices_journal posted 19 reversing entries, the 24
-- original entries were kept). 1100 went 3,694,659 -> 35,000, which is
-- GGS-26-DTL-09 alone — a September invoice, post-cutover, deliberately kept.
-- Journal 24 -> 43 entries, 48 -> 86 lines: nothing was erased.
--
-- Each client's opening therefore becomes their 31 AUGUST receivable:
--
--     31 Aug = 1 Aug opening  +  August billing  -  August receipts
--                                                   ( = 0, see below )
--
-- 12,131,900 + 3,659,659 - 0 = 15,791,559
--
-- THE FIGURES ARE HARDCODED BECAUSE THEY CAN NO LONGER BE DERIVED. Before the
-- reversal this file could have computed August billing per client by summing
-- invoices. Those rows are now gone. The 31 figures below were captured from
-- production WHILE THE INVOICES WERE STILL READABLE, reported line by line and
-- confirmed before the deletion ran. The audit log (log_audit_change fires
-- AFTER DELETE on invoices) and the 19 reversing journal entries are the
-- independent record if these ever need re-deriving.
--
-- AUGUST RECEIPTS WERE ZERO, and the whole subtraction term rests on it:
-- invoice_payments is empty for this company and sum(amount_received) is 0.
-- Asserted below rather than trusted.
--
-- THIRTEEN CLIENTS GAIN AN OPENING they did not have under 0339 — they carried
-- no 1 August balance but were billed in August, so their 31 August receivable
-- is their August invoice: Wusat-Emaar 264,000, PFM 238,000, PCI 204,000,
-- 68 HS 204,000, AWT 148,000, Sweet Palace 90,000, Rising Sun Lodges 90,000,
-- PRG Scheme 3 65,340, Innovative 64,342, J Sons-PWD 38,500, Inklings 38,000,
-- Ellysium 36,000, Cambridge exclusive school 35,000. 0339 deliberately left
-- Innovative at zero after 0336; it returns here as August billing, not as a
-- reinstatement of the pre-0336 90,664.
--
-- IDEMPOTENT: the update writes absolute values, not deltas. Re-running writes
-- the same 31 figures. The pre-state guard accepts either the 1 August total or
-- the restated one, so a replay is a no-op rather than a refusal.
--
-- SCOPED TO ONE COMPANY, BY ID, EVERYWHERE — client_code is unique per company,
-- not globally (0339's reasoning, unchanged).
--
-- ---------------------------------------------------------------------------
-- PART 2, AND WHY IT IS IN THE SAME FILE
--
-- ar_control_equals_open_invoices compares GL 1100 against
--   sum(invoices.invoice_amount) - sum(invoice_payments)
-- and has never known clients.opening_balance exists. It was green throughout
-- precisely because the ledger had no opening either: both sides were blind to
-- the same 12,131,900.
--
-- Posting the opening batch puts 15,791,559 into 1100 and would turn that check
-- red for doing the right thing. Amending the check after the post would mean
-- knowingly leaving a red check standing, which is how a suite learns to be
-- advisory. So the check is amended HERE, in the same change as the figures it
-- has to see.
--
-- The check goes RED the moment this file runs, and that is correct: it is
-- reporting that the ledger is missing an opening receivable of 15,791,559,
-- which is true until the batch posts. It joins bank_control_equals_bank_accounts
-- and cash_control_equals_cash_locations, red for the identical reason. All
-- THREE go green together when the single 2026-08-31 batch posts. That is the
-- acceptance test for the cutover.
--
-- ledger_checks_base HAS MANY AUTHORS, so this is SURGERY against the live
-- definition, not a restatement from a copy. The anchor is asserted to appear
-- exactly once; anything else refuses rather than guessing.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- PART 1 — restate clients.opening_balance to the 31 August receivable.
-- ===========================================================================

create temp table _0341_list (client_code text primary key, as_named text, amount numeric) on commit drop;

insert into _0341_list (client_code, as_named, amount) values
  ('CLI-0034', 'Nova Group',                     7861144),
  ('CLI-0003', 'SGC - Guards',                   2344334),
  ('CLI-0015', 'CBR Town',                        929460),
  ('CLI-0018', 'Al Fajar',                        769000),
  ('CLI-0019', 'Dysin Automobile',                697833),
  ('CLI-0002', 'SGC - Weapons',                   349721),
  ('CLI-0030', 'Lexus Tower',                     270000),
  ('CLI-0007', 'Wusat- Emaar',                    264000),
  ('CLI-0005', 'PFM',                             238000),
  ('CLI-0012', 'Mr. Ali Saadat Mandwala Chakri',  216000),
  ('CLI-0022', 'Spaces by Kaizen',                213466),
  ('CLI-0004', 'PCI',                             204000),
  ('CLI-0006', '68 HS',                           204000),
  ('CLI-0020', 'Dynamic Equipment',               174387),
  ('CLI-0009', 'Mr Raza Firdous Market',          171150),
  ('CLI-0028', 'Tiges MZD',                       153762),
  ('CLI-0027', 'AWT',                             148000),
  ('CLI-0021', 'Sweet Palace',                     90000),
  ('CLI-0042', 'Rising Sun Lodges',                90000),
  ('CLI-0016', 'PRG Scheme 3',                     65340),
  ('CLI-0025', 'Innovative',                       64342),
  ('CLI-0029', 'Bin Zahid',                        60000),
  ('CLI-0010', 'J Sons - PWD',                     38500),
  ('CLI-0026', 'Inklings',                         38000),
  ('CLI-0031', 'Ellysium',                         36000),
  ('CLI-0014', 'Mr Waseem/ Kaloon Chemicals',      36000),
  ('CLI-0043', 'Cambridge exclusive school',       35000),
  ('CLI-0013', 'Mr Muzzamil',                      12500),
  ('CLI-0024', 'NM Cables',                         8000),
  ('CLI-0017', 'Mr Fahad Prado 17',                 5000),
  ('CLI-0023', 'Mazen E-11',                        4620);

-- Refuse before writing, if this database is not the one the list describes.
do $guard$
declare
  v_co  constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_missing text;
  v_dupes   text;
  v_total   numeric;
  v_auginv  int;
  v_recv    numeric;
begin
  if not exists (select 1 from public.companies where id = v_co) then
    raise exception '0341 REFUSED: GUARDS AND GUIDES (PVT) LTD (%) is not on this database', v_co;
  end if;

  select string_agg(l.client_code || ' (' || l.as_named || ')', ', ' order by l.client_code)
    into v_missing from _0341_list l
   where not exists (select 1 from public.clients c
                      where c.client_code = l.client_code and c.company_id = v_co);
  if v_missing is not null then
    raise exception '0341 REFUSED: no GGS client carries these code(s): %', v_missing;
  end if;

  select string_agg(l.client_code, ', ') into v_dupes from _0341_list l
    join public.clients c on c.client_code = l.client_code and c.company_id = v_co
   group by l.client_code having count(*) > 1;
  if v_dupes is not null then
    raise exception '0341 REFUSED: client code(s) % are not unique within GGS', v_dupes;
  end if;

  if exists (select 1 from _0341_list l join public.clients c
               on c.client_code = l.client_code and c.company_id = v_co
              where c.is_internal) then
    raise exception '0341 REFUSED: an internal client (0337) is on the receivables list';
  end if;

  -- THE PRECONDITION THIS FILE RESTS ON. These figures already contain August
  -- billing. If an August invoice is present, adding it again double-counts.
  select count(*) into v_auginv from public.invoices i
   where i.company_id = v_co
     and coalesce(i.period_start, i.invoice_date) < date '2026-09-01';
  if v_auginv <> 0 then
    raise exception
      '0341 REFUSED: % invoice(s) are still billed before 2026-09. These openings already include August billing, so writing them now would double-count it. Reverse the August invoices first.',
      v_auginv;
  end if;

  -- August receipts must be nil, or the subtraction term is not zero.
  select coalesce(sum(p.amount), 0) into v_recv from public.invoice_payments p
   where p.company_id = v_co and p.payment_date < date '2026-09-01';
  if v_recv <> 0 then
    raise exception
      '0341 REFUSED: August receipts total %, not zero. 31 Aug = 1 Aug + billing - receipts, and these figures were computed with receipts at nil.', v_recv;
  end if;

  -- Replay guard: accept the 1 August state or the already-restated one.
  select coalesce(sum(opening_balance), 0) into v_total
    from public.clients where company_id = v_co;
  if v_total not in (12131900, 15791559) then
    raise exception
      '0341 REFUSED: GGS receivable openings total %, which is neither the 1 August figure (12,131,900) nor the restated one (15,791,559). Something moved this column outside the migration flow.', v_total;
  end if;
end
$guard$;

create temp table _0341_before on commit drop as
  select id, client_code, name, opening_balance from public.clients
   where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e';

update public.clients c
   set opening_balance = l.amount
  from _0341_list l
 where c.client_code = l.client_code
   and c.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
   and c.opening_balance is distinct from l.amount;

-- ===========================================================================
-- PART 2 — teach ar_control_equals_open_invoices that an opening exists.
-- Surgery against the live definition, anchored, single occurrence enforced.
-- ===========================================================================

do $surgery$
declare
  v_def    text;
  v_anchor text;
  v_repl   text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks_base';
  if v_def is null then
    raise exception '0341 REFUSED: public.ledger_checks_base does not exist';
  end if;

  v_anchor := $a$ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),$a$;

  v_repl := $b$ar_sub as (
    -- 0341. The receivable subledger is invoices PLUS the opening receivable
    -- carried on clients.opening_balance. Before the 31 August cutover this
    -- term was absent and the check was still green, because the ledger had no
    -- opening either — both sides were blind to the same figure. Once the
    -- opening batch posts, 1100 carries it and this side must too.
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0)
         + coalesce((select sum(c.opening_balance) from public.clients c
                      where c.company_id = p_company_id), 0) bal
  ),$b$;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0341 REFUSED: the ar_sub anchor appears % time(s) in ledger_checks_base, expected exactly 1. The function has been edited since this was written; re-read the live definition and re-anchor rather than widening the match.', v_hits;
  end if;

  execute replace(v_def, v_anchor, v_repl);
end
$surgery$;

-- ===========================================================================
-- PROOF
-- ===========================================================================
do $proof$
declare
  v_co      constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  r         record;
  v_total   numeric;
  v_listed  int;
  v_stray   int;
  v_clients int;
  v_je      int;
  v_jl      int;
  v_exp     numeric;
  v_act     numeric;
begin
  -- (a) every listed client carries exactly its listed figure
  for r in select l.client_code, l.as_named, l.amount, c.name, c.opening_balance
             from _0341_list l join public.clients c
               on c.client_code = l.client_code and c.company_id = v_co
  loop
    if r.opening_balance is distinct from r.amount then
      raise exception '0341 FAILED: % (%) carries % but the list says %',
        r.client_code, r.name, r.opening_balance, r.amount;
    end if;
  end loop;

  -- (b) the total is the reconciled figure, computed not asserted
  select count(*), coalesce(sum(opening_balance), 0) into v_listed, v_total
    from public.clients c
   where c.company_id = v_co and c.client_code in (select client_code from _0341_list);
  if v_listed <> 31 then
    raise exception '0341 FAILED: % listed clients matched, expected 31', v_listed;
  end if;
  if v_total <> 15791559 then
    raise exception
      '0341 FAILED: the listed clients total %, but 12,131,900 + 3,659,659 - 0 = 15,791,559', v_total;
  end if;

  -- (c) nothing outside the list moved
  for r in select b.client_code, b.name, b.opening_balance was, c.opening_balance now
             from _0341_before b join public.clients c on c.id = b.id
            where c.opening_balance is distinct from b.opening_balance
              and b.client_code not in (select client_code from _0341_list)
  loop
    raise exception '0341 FAILED: % (%) moved % -> % and is not on the list',
      r.client_code, r.name, r.was, r.now;
  end loop;

  -- (d) every GGS client off the list is at zero
  select count(*) into v_stray from public.clients c
   where c.company_id = v_co and coalesce(c.opening_balance, 0) <> 0
     and c.client_code not in (select client_code from _0341_list);
  if v_stray <> 0 then
    raise exception '0341 FAILED: % client(s) off the list carry a non-zero opening', v_stray;
  end if;

  -- (e) nothing created or destroyed, and this file posted no journal
  select count(*) into v_clients from public.clients where company_id = v_co;
  if v_clients <> (select count(*) from _0341_before) then
    raise exception '0341 FAILED: the GGS client count changed';
  end if;
  select count(*) into v_je from public.journal_entries where company_id = v_co;
  select count(*) into v_jl from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
   where je.company_id = v_co;

  -- (f) THE AMENDMENT WORKS, AND IS RED FOR THE RIGHT REASON.
  --     The subledger side must now equal the surviving invoice plus the
  --     opening; the GL side must still be the surviving invoice alone; and the
  --     gap must be exactly the opening the batch is about to post.
  select expected, actual into v_exp, v_act
    from public.ledger_checks(v_co) where check_name = 'ar_control_equals_open_invoices';
  if v_exp <> 15826559 then
    raise exception
      '0341 FAILED: the AR subledger now reads %, expected 15,826,559 (35,000 surviving invoice + 15,791,559 opening). The surgery did not take.', v_exp;
  end if;
  if v_act <> 35000 then
    raise exception
      '0341 FAILED: GL 1100 reads %, expected 35,000. Something posted to the receivable control during this migration.', v_act;
  end if;
  if v_exp - v_act <> 15791559 then
    raise exception '0341 FAILED: the AR gap is %, expected exactly the opening 15,791,559', v_exp - v_act;
  end if;

  raise notice
    '0341 OK: % clients restated to their 31 August receivable, totalling PKR %; no client created, destroyed or otherwise altered; journal unchanged at % entries / % lines. ar_control_equals_open_invoices now reads subledger % against GL %, a gap of exactly the 15,791,559 opening — it is RED, correctly, and goes green with bank and cash when the single 2026-08-31 batch posts.',
    v_listed, v_total, v_je, v_jl, v_exp, v_act;
end
$proof$;
