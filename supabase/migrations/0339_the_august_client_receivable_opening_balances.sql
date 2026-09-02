-- 0339 — the August 2026 client receivable opening balances.
--
-- WHAT THIS IS. The opening receivable per client as at 1 August 2026, supplied
-- as a 41-row list and entered here. 18 clients carry a figure; they total
-- PKR 12,131,900. Every other client is left at zero.
--
-- WHY THE COLUMN AND NOT A BATCH. Client Receivables reads
-- clients.opening_balance and derives each month from it:
--
--   opening(month) = opening_balance
--                  + invoices billed BEFORE that month
--                  - payments received BEFORE that month
--
-- Production has 19 invoices, ALL billed August 2026, and ZERO payments. So for
-- August both correction terms are nil and the August opening column IS
-- clients.opening_balance, unmodified. September then computes as August's
-- opening plus August's invoices, which is the roll-forward that was asked for
-- and which the screen already does. Nothing here has to add anything up.
--
-- 0336's header said an opening receivable belongs in an opening balance batch
-- posted to the receivables control account, and that is still true and still
-- not done: opening_balance_batches is empty, and this file does not change
-- that. This is the figure the RECEIVABLES SCREEN shows, entered where that
-- screen reads it. The ledger still does not know about it. That gap is real
-- and is being carried deliberately so the screen is usable now; it closes when
-- somebody decides the go-live opening position, which is an accounting
-- decision and not a migration's.
--
-- THERE IS NO LOCK ON THIS COLUMN, and it is worth writing down because the
-- change was authorised as an override. public.clients carries five triggers —
-- fill_company_id, the branch cascade, gen_client_code, the archive guard and
-- the audit log — and none of them locks opening_balance. accounting_periods is
-- empty so no period is closed, and 0279's opening-balance lock is on PARTNERS,
-- not clients. Nothing is being forced. The audit log records every change,
-- which is the trail this leaves.
--
-- THIS RESTATES EIGHT FIGURES that were on the same clients before 0336 cleared
-- the column this morning. The list supersedes them, confirmed explicitly. The
-- differences, so the restatement is legible rather than silent:
--
--                                  was (pre-0336)      now        change
--   SGC - Guards                        1,453,404   2,344,334    +890,930
--   SGC - Weapons                         207,829     276,581     +68,752
--   Nova Group                          6,354,167   5,961,647    -392,520
--   CBR Town                              961,900     847,620    -114,280
--   Tiges MZD                              10,362     153,762    +143,400
--   Mr Waseem/ Kaloon Chemicals             6,500      30,000     +23,500
--   Al Fajar                              769,004     769,000          -4
--   Spaces by Kaizen                      238,466     213,466     -25,000
--   Innovative                             90,664           0     -90,664
--
-- and five clients carry a balance that had none before 0336: Mr Raza Firdous
-- Market 171,150, Dysin Automobile 697,833, Dynamic Equipment 174,387, Bin
-- Zahid 48,000, Lexus Tower 270,000.
--
-- THREE MAPPING DECISIONS, taken by the author of the list, not inferred:
--
--   * "NOVA CITY" is the client stored as Nova Group (CLI-0034). It is 49% of
--     the total, so it was confirmed rather than matched by eye.
--   * "Allah Walay Trust" is the client stored as AWT (CLI-0027). It carries no
--     figure, so this mapping changes nothing today; it is recorded because the
--     next person to read the list will ask.
--   * Six list rows have no client and are DELIBERATELY SKIPPED — Popular Brand
--     (104,465), Al Rabi International (208,930), Popular Water Tank (88,078),
--     Waheed Shahzad Water Tank (208,930), Mr Salaar/Gulrez (—), Berger Paints
--     (—). PKR 610,403 of the list is therefore NOT entered, and the receivables
--     total will read 12,131,900 rather than 12,742,303. That is a decision, not
--     an omission, and this paragraph is the only place it is written down.
--
-- Four of the eighteen — CLI-0017, CLI-0022, CLI-0023, CLI-0024 — exist only
-- because 0338 restored them. This file REFUSES if they are absent rather than
-- silently setting 14 of 18 balances and reporting success.
--
-- Seven clients on production are not on the list at all and stay at zero:
-- Apex World, Bank of AJK, Breakout, Cambridge exclusive school, HMC Taxila,
-- Premier Sales, Regent 1. Two of them have August invoices, which is
-- consistent with their being new.
--
-- IDEMPOTENT: re-running writes the same figures. It is not additive.
--
-- SCOPED TO ONE COMPANY, BY ID, EVERYWHERE. client_code is unique per company,
-- NOT globally: the development database carries 38 rows holding the 18 codes
-- below, spread across four companies. A join on client_code alone would be
-- correct on production today, where there is one company, and would quietly
-- restate three other companies' receivables the moment there are two. Every
-- statement in this file therefore also matches
-- company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' (GUARDS AND GUIDES
-- (PVT) LTD), and every assertion is scoped the same way.

-- ---------------------------------------------------------------------------
-- 0. The list, as data. Keyed by CLIENT CODE rather than name — the codes are
--    stable and the list's names are not ("NOVA CITY", "Mr. Muzammal",
--    "Tiges School MZD", "Elysium"). Keyed by name this file would silently
--    match nothing for a third of its rows.
-- ---------------------------------------------------------------------------
create temp table _0339_list (client_code text primary key, as_listed text, amount numeric) on commit drop;

insert into _0339_list (client_code, as_listed, amount) values
  ('CLI-0002', 'SGC-Weapons',                  276581),
  ('CLI-0003', 'SGC-Guards',                  2344334),
  ('CLI-0009', 'Mr. Raza, Firdous Market (Al-Hafeez)', 171150),
  ('CLI-0034', 'NOVA CITY',                   5961647),
  ('CLI-0012', 'Mr. Ali Saadat, Mandwala Chakri', 144000),
  ('CLI-0013', 'Mr. Muzammal',                  12500),
  ('CLI-0014', 'Mr. Waseem/ Kaloon Chemicals',  30000),
  ('CLI-0015', 'CBR-Town',                     847620),
  ('CLI-0017', 'Mr. Fahad Ibrahim, Prado-17',    5000),
  ('CLI-0018', 'Al-Fajar',                     769000),
  ('CLI-0019', 'Dysin automobile',             697833),
  ('CLI-0020', 'Dynamic Equipment',            174387),
  ('CLI-0022', 'Spaces By Kaizen',             213466),
  ('CLI-0023', 'Mazen E-11',                     4620),
  ('CLI-0024', 'NM Cables',                      8000),
  ('CLI-0028', 'Tiges School MZD',             153762),
  ('CLI-0029', 'Bin Zahid',                     48000),
  ('CLI-0030', 'Lexus Tower',                  270000);

-- The list's zero rows, named so that "absent from the list" and "listed at
-- nothing" are distinguishable later. These are asserted to end at zero; they
-- are not written, because 0336 already left them there.
create temp table _0339_zeros (client_code text primary key) on commit drop;
insert into _0339_zeros values
  ('CLI-0001'),('CLI-0004'),('CLI-0005'),('CLI-0006'),('CLI-0007'),('CLI-0008'),
  ('CLI-0010'),('CLI-0011'),('CLI-0016'),('CLI-0021'),('CLI-0025'),('CLI-0026'),
  ('CLI-0027'),('CLI-0031'),('CLI-0033'),('CLI-0042'),('CLI-0044');

-- ---------------------------------------------------------------------------
-- 1. Refuse before writing anything, if the list does not describe this
--    database. A partial application here is a wrong receivables report that
--    nobody has a reason to distrust.
-- ---------------------------------------------------------------------------
do $guard$
declare
  v_co    constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_missing text;
  v_dupes   text;
begin
  if not exists (select 1 from public.companies where id = v_co) then
    raise exception '0339 REFUSED: GUARDS AND GUIDES (PVT) LTD (%) is not on this database', v_co;
  end if;

  select string_agg(l.client_code || ' (' || l.as_listed || ')', ', ' order by l.client_code)
    into v_missing
    from _0339_list l
   where not exists (select 1 from public.clients c where c.client_code = l.client_code and c.company_id = v_co);
  if v_missing is not null then
    raise exception
      '0339 REFUSED: no GGS client carries these code(s): %. CLI-0017/0022/0023/0024 come from 0338 — run it first.', v_missing;
  end if;

  select string_agg(l.client_code, ', ') into v_dupes
    from _0339_list l join public.clients c on c.client_code = l.client_code and c.company_id = v_co
   group by l.client_code having count(*) > 1;
  if v_dupes is not null then
    raise exception
      '0339 REFUSED: client code(s) % are not unique within GGS, so the list does not identify one client each', v_dupes;
  end if;

  if exists (select 1 from _0339_list l join public.clients c on c.client_code = l.client_code and c.company_id = v_co where c.is_internal) then
    raise exception '0339 REFUSED: an internal client (0337) is on the receivables list — an internal placeholder is never invoiced and cannot be owed anything';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 2. Write them.
-- ---------------------------------------------------------------------------
-- The whole company, not just the listed rows: (c) has to be able to see a
-- client that moved and should not have.
create temp table _0339_before on commit drop as
  select id, client_code, name, opening_balance from public.clients
   where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e';

update public.clients c
   set opening_balance = l.amount
  from _0339_list l
 where c.client_code = l.client_code
   and c.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
   and c.opening_balance is distinct from l.amount;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- (a) every listed client carries exactly its listed figure;
-- (b) the total is 12,131,900 — the sum of the list minus the six skipped rows.
--     Computed from the table and compared against the figure in the header, so
--     a mistyped row is caught by the arithmetic rather than by a reader;
-- (c) NO CLIENT OUTSIDE THE LIST MOVED. The update joins on client_code, but a
--     join that matched too much would satisfy (a) and (b) unchanged. Compared
--     row by row against the before-state;
-- (d) the clients the list shows as "-" really are at zero — asserted, not
--     assumed from 0336 having run;
-- (e) NOTHING WAS CREATED OR DESTROYED, and the ledger did not move. clients
--     has no journal trigger; this is the assertion that will notice if that
--     ever stops being true;
-- (f) AUGUST'S OPENING COLUMN EQUALS WHAT WAS WRITTEN. This is the claim the
--     whole file rests on — that opening_balance IS the August opening — and it
--     is true only while no invoice is billed before August and no payment
--     predates it. Both are checked here rather than in the header, because the
--     header cannot fail.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co       constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  r          record;
  v_total    numeric;
  v_listed   int;
  v_nonzero  int;
  v_clients  int;
  v_je       int;
  v_jl       int;
  v_pre_inv  int;
  v_pre_pay  int;
  v_zerobad  text;
begin
  -- (a)
  for r in select l.client_code, l.as_listed, l.amount, c.name, c.opening_balance
             from _0339_list l join public.clients c
                    on c.client_code = l.client_code and c.company_id = v_co
  loop
    if r.opening_balance is distinct from r.amount then
      raise exception
        '0339 FAILED: % (% / listed as "%") carries % but the list says %',
        r.client_code, r.name, r.as_listed, r.opening_balance, r.amount;
    end if;
  end loop;

  -- (b)
  select count(*), coalesce(sum(opening_balance), 0)
    into v_listed, v_total
    from public.clients c
   where c.company_id = v_co
     and c.client_code in (select client_code from _0339_list);
  if v_listed <> 18 then
    raise exception '0339 FAILED: % listed clients matched, expected 18', v_listed;
  end if;
  if v_total <> 12131900 then
    raise exception
      '0339 FAILED: the listed clients total % — the header says 12,131,900, so one of the two is wrong and it is not safe to guess which', v_total;
  end if;

  -- (c)
  for r in select b.client_code, b.name, b.opening_balance as was, c.opening_balance as now
             from _0339_before b join public.clients c on c.id = b.id
            where c.opening_balance is distinct from b.opening_balance
              and b.client_code not in (select client_code from _0339_list)
  loop
    raise exception
      '0339 FAILED: % (%) moved from % to % and is not on the list — the update reached past its join',
      r.client_code, r.name, r.was, r.now;
  end loop;
  for r in select b.client_code, b.name from _0339_before b join public.clients c on c.id = b.id
            where c.name is distinct from b.name
  loop
    raise exception '0339 FAILED: % (%) changed beyond its opening balance', r.client_code, r.name;
  end loop;

  -- (d)
  select string_agg(c.client_code || ' ' || c.name || '=' || c.opening_balance, ', ')
    into v_zerobad
    from public.clients c join _0339_zeros z on z.client_code = c.client_code
   where c.company_id = v_co and coalesce(c.opening_balance, 0) <> 0;
  if v_zerobad is not null then
    raise exception '0339 FAILED: these are shown as "-" on the list but carry a balance: %', v_zerobad;
  end if;

  -- and no GGS client outside the list carries one either
  select count(*) into v_nonzero from public.clients c
   where c.company_id = v_co
     and coalesce(c.opening_balance, 0) <> 0
     and c.client_code not in (select client_code from _0339_list);
  if v_nonzero <> 0 then
    raise exception '0339 FAILED: % client(s) not on the list carry a non-zero opening balance', v_nonzero;
  end if;

  -- (e)
  select count(*) into v_clients from public.clients where company_id = v_co;
  if v_clients <> (select count(*) from _0339_before) then
    raise exception '0339 FAILED: the GGS client count changed — this file writes one column, it does not create or delete clients';
  end if;
  select count(*) into v_je from public.journal_entries where company_id = v_co;
  -- journal_lines carries no company_id — it is scoped through its entry.
  select count(*) into v_jl from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
   where je.company_id = v_co;

  -- (f) the assumption the whole file rests on
  select count(*) into v_pre_inv from public.invoices i
   where i.company_id = v_co
     and coalesce(i.period_start, i.invoice_date) < date '2026-08-01';
  select count(*) into v_pre_pay from public.invoice_payments p
   where p.company_id = v_co and p.payment_date < date '2026-08-01';
  if v_pre_inv <> 0 or v_pre_pay <> 0 then
    raise exception
      '0339 FAILED: % invoice(s) billed before August and % payment(s) received before it. Client Receivables would then show August opening as opening_balance + % - %, NOT the figures written here. The list must be restated as an as-at-inception balance, or entered as an opening balance batch.',
      v_pre_inv, v_pre_pay, v_pre_inv, v_pre_pay;
  end if;

  raise notice
    '0339 OK: % client(s) set, totalling PKR %, and every other client verified at zero; no client created, destroyed or otherwise altered; journal unchanged at % entries / % lines. No invoice is billed before 2026-08 and no payment predates it, so August''s opening column equals these figures exactly and September''s will be these plus August''s invoices. Six list rows (PKR 610,403) have no client and were deliberately skipped — see the header.',
    v_listed, v_total, v_je, v_jl;
end
$proof$;
