-- 0476 — partner custody entries carry the decided sign.
--
-- 0445 settled the ledger's sign (DECIDED): balance = opening + remuneration −
-- cash paid, and POSITIVE MEANS THE COMPANY OWES THE PARTNER. The DRAWING,
-- CONTRIBUTION and GL arms follow it. The CUSTODY arms never did: they were
-- written in 0218 (0218_partner_ledger_bound_months.sql:88 for TRANSFER_IN) under
-- the old wording "positive = the partner owes the company", and 0445 changed the
-- wording without touching them. Every custody entry therefore moved the balance
-- the wrong way.
--
-- The instance: 16 Sep 2026, 209,000 transferred from Shayan Ahmed's custody to
-- Shujaat Mehmood's. Company cash in a partner's hands is owed back to the
-- company, so it reduces what the company owes him. The ledger ADDED it:
-- Shujaat read +127,040 where the rule gives −290,960.
--
-- DECIDED (Shayan, 2026-09-23): cash HANDED TO a partner-custodian reduces the
-- balance; cash he SPENDS for the company increases it back.
--
--   CUSTODY:CLIENT_CASH     client cash collected into his hands    reduces
--   CUSTODY:CHEQUE          cash cheque cleared into his hands      reduces
--   CUSTODY:TRANSFER_IN     custody handed to him                   reduces
--   CUSTODY:BANK            +cash_delta: follows the cash — a withdrawal into
--                           his cash reduces, payroll paid out of it increases
--   CUSTODY:EXPENSE         spent for the company                   increases
--   CUSTODY:ADVANCE         spent for the company                   increases
--   CUSTODY:VENDOR_PAYMENT  spent for the company                   increases
--   CUSTODY:TRANSFER_OUT    custody handed on out of his hands      increases
--
-- In x_cash terms (balance subtracts x_cash): every custody arm's x_cash is
-- negated, and nothing else changes.
--
-- DEFERRED — BANK:* (the pbank arm) is left untouched. It carries bank accounts
-- OWNED by a partner, which is not custody, and whether such an account holds
-- company money is not decided. No partner owns one today, so it moves nothing.
-- If the answer is "company money", the change is the same negation on
-- -bt.account_delta, and the reason is the same as CUSTODY:BANK's.
--
-- DEFERRED — SETTLEMENT. Partner-held custody sits in 1000 Cash in Hand (e.g.
-- 1000.05 Shujaat Mehmood), so this ledger's reduction and the balance sheet's
-- cash are two views of ONE asset. They become a double count only at
-- settlement, and nothing settles yet (profit_allocation_runs is empty). The
-- future check, `partner_settlement_clears_custody`, ASSERTS for every POSTED
-- profit_allocation run R and every partner P with a custody location L:
--   held   = GL balance (debit − credit) of L.coa_account_id at R's settlement date
--   share  = P's credit on his capital account from R
--   R's settlement posting credits L.coa_account_id by exactly least(share, held)
--   the excess paid out to P is exactly share − least(share, held)
--   a payout to P while L.coa_account_id still carries a debit balance is REFUSED
-- OPEN within the deferral: share < held (he holds more than his share settles).
-- The rule as given assumes custody returns to zero; that sub-case is unanswered.
--
-- SURGERY against the live body: partner_ledger has been edited by 0207–0218,
-- 0354, 0445, 0470 and others, so no file holds its text. Each anchor asserted
-- once, against a body whose md5 is recognised.

create or replace function pg_temp.surg(p_fn text, p_old text, p_new text, p_expect int)
returns void language plpgsql as $fn$
declare v_def text; v_hits int;
begin
  -- The live body is LF-only. Text pasted from a Windows editor arrives CRLF,
  -- and a multi-line anchor carrying \r then matches nothing. Strip it.
  p_old := replace(p_old, chr(13), '');
  p_new := replace(p_new, chr(13), '');
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = p_fn;
  if v_def is null then raise exception '0476 REFUSED: % does not exist.', p_fn; end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> p_expect then
    raise exception '0476 REFUSED: in %, the anchor appears % time(s), expected %. Anchor began: %',
      p_fn, v_hits, p_expect, left(p_old, 70);
  end if;
  execute replace(v_def, p_old, p_new);
end $fn$;

-- Each partner's closing balance and custody sum BEFORE, for the assertion below.
drop table if exists pg_temp.t0476_before;
create temp table t0476_before as
select p.id, p.name,
       (select l.balance from public.partner_ledger(p.id, null, null) l
         order by l.entry_date desc, l.source limit 1) as closing,
       (select coalesce(sum(l.cash_paid), 0) from public.partner_ledger(p.id, null, null) l
         where l.source like 'CUSTODY:%') as custody_cash,
       (select count(*) from public.partner_ledger(p.id, null, null) l
         where l.source like 'CUSTODY:%') as custody_rows
  from public.partners p;

drop table if exists pg_temp.t0476_state;
create temp table t0476_state as select false as flipped;

do $mig$
declare v_src text; v_md5 text;
begin
  select prosrc into v_src from pg_proc where oid = 'public.partner_ledger(uuid,date,date)'::regprocedure;
  if v_src like '%0476: CUSTODY SIGN%' then
    raise notice '0476: already applied — the custody arms carry the 0476 marker. Nothing to do.';
    return;
  end if;

  select md5(pg_get_functiondef('public.partner_ledger(uuid,date,date)'::regprocedure)) into v_md5;
  if v_md5 <> '1070fe0c7065c3c6acee9ef269d304b2' then
    raise exception '0476 REFUSED: partner_ledger is not the body these anchors were counted against (md5 %). Recount them against the live definition.', v_md5;
  end if;

  perform pg_temp.surg('partner_ledger',
$a$  custody as (
$a$,
$b$  -- 0476: CUSTODY SIGN. Cash handed TO a partner-custodian reduces what the
  -- company owes him (x_cash positive); cash he spends for the company
  -- increases it back (x_cash negative). DECIDED 2026-09-23.
  custody as (
$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$           -ip.amount, 0::numeric, 'CUSTODY:CLIENT_CASH'::text, null::uuid$a$,
$b$           ip.amount, 0::numeric, 'CUSTODY:CLIENT_CASH'::text, null::uuid$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$           e.amount, 0::numeric, 'CUSTODY:EXPENSE'::text, null::uuid$a$,
$b$           -e.amount, 0::numeric, 'CUSTODY:EXPENSE'::text, null::uuid$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$           vp.amount, 0::numeric, 'CUSTODY:VENDOR_PAYMENT'::text, null::uuid$a$,
$b$           -vp.amount, 0::numeric, 'CUSTODY:VENDOR_PAYMENT'::text, null::uuid$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$'ADVANCE', a.amount, 0::numeric, 'CUSTODY:ADVANCE'::text$a$,
$b$'ADVANCE', -a.amount, 0::numeric, 'CUSTODY:ADVANCE'::text$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$           -ch.amount, 0::numeric, 'CUSTODY:CHEQUE'::text, null::uuid$a$,
$b$           ch.amount, 0::numeric, 'CUSTODY:CHEQUE'::text, null::uuid$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$'TRANSFER IN', -t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text$a$,
$b$'TRANSFER IN', t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$'TRANSFER OUT', t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text$a$,
$b$'TRANSFER OUT', -t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$           -bt.cash_delta, 0::numeric, 'CUSTODY:BANK'::text, null::uuid$a$,
$b$           bt.cash_delta, 0::numeric, 'CUSTODY:BANK'::text, null::uuid$b$, 1);

  perform pg_temp.surg('partner_ledger',
$a$  pbank as (
$a$,
$b$  -- 0476: DEFERRED. Bank accounts OWNED by a partner are not custody; whether
  -- they hold company money is undecided. Sign left as 0218 wrote it. If the
  -- answer is "company money", negate -bt.account_delta as CUSTODY:BANK was.
  pbank as (
$b$, 1);

  update t0476_state set flipped = true;
end $mig$;

comment on function public.partner_ledger(uuid, date, date) is
  '0445/0476: a partner''s running position. Remuneration is ONLY what a POSTED profit_allocation run put on the capital account; a month with no posted run shows as NOT ALLOCATED and is never computed. Balance = opening + remuneration − cash paid; POSITIVE = THE COMPANY OWES THE PARTNER (DECIDED). 0476: custody entries follow the same sign — cash handed TO a partner-custodian reduces the balance, cash he spends for the company increases it (DECIDED 2026-09-23). DEFERRED: BANK:* on partner-owned accounts (not custody; sign untouched). DEFERRED: settlement — check partner_settlement_clears_custody must assert that each POSTED run credits the partner''s custody account by least(share, held) before paying share − least(share, held), and refuse a payout while his custody account carries a debit balance; share < held is unanswered. See 0476''s header.';

-- ---------------------------------------------------------------------------
-- THE TEXT: every custody arm carries the new sign, the BANK:* arm the old one.
-- ---------------------------------------------------------------------------
do $$
declare v_src text; v_want text; v_bad text := '';
begin
  select prosrc into v_src from pg_proc where oid = 'public.partner_ledger(uuid,date,date)'::regprocedure;
  foreach v_want in array array[
    $x$ ip.amount, 0::numeric, 'CUSTODY:CLIENT_CASH'$x$,
    $x$-e.amount, 0::numeric, 'CUSTODY:EXPENSE'$x$,
    $x$-vp.amount, 0::numeric, 'CUSTODY:VENDOR_PAYMENT'$x$,
    $x$-a.amount, 0::numeric, 'CUSTODY:ADVANCE'$x$,
    $x$ ch.amount, 0::numeric, 'CUSTODY:CHEQUE'$x$,
    $x$ t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'$x$,
    $x$-t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'$x$,
    $x$ bt.cash_delta, 0::numeric, 'CUSTODY:BANK'$x$,
    $x$-bt.account_delta, 0::numeric, 'BANK:'$x$
  ] loop
    if position(v_want in v_src) = 0 then v_bad := v_bad || ' [' || v_want || ']'; end if;
  end loop;
  if v_bad <> '' then
    raise exception '0476 FAILED: partner_ledger does not carry the decided sign on:%', v_bad;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE BALANCES. The failure guarded against is "a custody arm kept its old
-- sign", which leaves the closing balance where it was. Negating the custody
-- rows moves each closing balance by exactly 2 × (custody sum before), and the
-- custody sum itself must come back negated. A partner with no custody rows
-- must not move at all. Both are distinguishable from the unfixed state for
-- any partner whose custody sum is non-zero.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_close numeric; v_cust numeric; v_moved int := 0;
begin
  if not (select flipped from t0476_state) then
    raise notice '0476: surgery skipped (already applied); balance assertion not applicable on replay.';
    return;
  end if;
  for r in select * from t0476_before loop
    select l.balance into v_close from public.partner_ledger(r.id, null, null) l
     order by l.entry_date desc, l.source limit 1;
    select coalesce(sum(l.cash_paid), 0) into v_cust from public.partner_ledger(r.id, null, null) l
     where l.source like 'CUSTODY:%';
    if v_cust is distinct from -r.custody_cash then
      raise exception '0476 FAILED: % custody sum is %, expected % (the negation of %).', r.name, v_cust, -r.custody_cash, r.custody_cash;
    end if;
    if v_close is distinct from r.closing + 2 * r.custody_cash then
      raise exception '0476 FAILED: % closes at %, expected % (before % + 2 × custody %).', r.name, v_close, r.closing + 2 * r.custody_cash, r.closing, r.custody_cash;
    end if;
    if r.custody_cash <> 0 then v_moved := v_moved + 1; end if;
    raise notice '0476: % — custody rows %, closing % -> %', r.name, r.custody_rows, r.closing, v_close;
  end loop;
  raise notice '0476: % partner(s) moved.', v_moved;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0476 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;

drop table if exists pg_temp.t0476_before;
drop table if exists pg_temp.t0476_state;
