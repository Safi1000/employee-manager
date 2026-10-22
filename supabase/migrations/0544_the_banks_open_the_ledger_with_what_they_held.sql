-- 0544 — the banks open the ledger with what they held
--
-- Asked 2026-10-22 (Shayan, from the Dashboard's cash panel: "The ledger holds
-- 3.11M on these accounts; the recorded bank and cash balances say 10.21M …
-- post them in Opening Balances and the two will agree — fix this issue").
--
-- The ledger begins on 1 August 2026. What the four banks held before it began
-- was never posted, so every bank account in the ledger is short by its
-- opening — BOAJK and Allied even read negative. Per bank, the opening is the
-- recorded balance less every recorded movement (bank_transactions), which is
-- the same figure the unposted draft batch carries for each:
--
--   Askari  3,619,821.00   as at 31 August (0523's correction note states it)
--   BOAJK   2,368,041.00
--   Allied    707,902.00
--   Soneri    775,855.23
--
-- Askari has one ledger entry dated in August (the 26,000 advance of 30 Aug,
-- 0523), which its 31 August figure already reflects; so its opening at the
-- START of August is 3,619,821 + 26,000 = 3,645,821. The others have no
-- August bank entries.
--
-- The change:
--   1. One opening batch dated 1 August 2026 — the ledger's first day, so the
--      month pickers (ledger_start_date) do not grow an empty July — with the
--      four banks Dr and 3200 Opening Balance Equity Cr 7,497,619.23, posted
--      through post_journal exactly as post_opening_balances posts a batch
--      (that function asks coa.view of a signed-in user, which a migration is
--      not). It is NOT dated the cutover date (31 Aug), so it is not taken
--      for the cutover: ledger_cutover_posted stays false and the cutover date
--      stays movable.
--   2. The unposted draft batch 9d90fee2 (dated 3 Sep, 7 lines) carries the
--      same four bank lines. They come out of it, and its 3200 line falls by
--      their 7,471,619.23, so it still balances and can never post the banks a
--      second time. What remains is receivables 24,711,339 and Gul Rehman 890.
--
-- For the cutover (docs/audits/2026-10-ledger-work-queue.md): this entry is
-- dated before 31 August, so the cutover archives it with the rest of August
-- and its redraft — drawn from the GL — carries the banks at their 31 August
-- balances. The redraft must NOT add bank openings again; the stale
-- 2026-08-31-cutover-batch-proposed.csv still has them and is superseded on
-- that point.
--
-- Not changed here, and why each bank will not read exactly zero:
--   * Askari stays 114,500 off: Shayan's September payslip, 114,500 paid of
--     129,500. A payslip posts its disbursement when it is fully paid; the
--     bank moved on 15 Oct. It clears when the payslip is finished.
--   * BOAJK stays 38,000 off: Roshan Khan's September salary, paid 38,000 from
--     BOAJK and 7,000 in cash on 21 Oct — before 0541 — and posted wholly to
--     his cash (1000.07, which is 38,000 off the other way). That is a repost
--     of one payslip, its own change with its own approval.
--
-- Asserted on the things that can break: after the post, each bank's
-- difference in bank_held_operational is exactly the residual named above —
-- Allied 0, Soneri 0, Askari +114,500, BOAJK +38,000 (the ledger holding what
-- the bank has already paid out) — so a wrong amount, a
-- wrong account or a double post all fail; the entry balances; the draft
-- batch still balances and carries no bank line; the cutover is not posted.

do $mig$
declare
  v_co  constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_draft constant uuid := '9d90fee2-c184-4ca2-8283-018105c415ba';
  v_obe uuid; v_ho uuid; v_batch uuid; v_entry uuid; v_lines jsonb;
  r record; v_bad text := ''; v_bank_gl uuid[];
  v_open constant jsonb := '{"Askari Bank": 3645821.00, "BOAJK": 2368041.00, "Allied Bank": 707902.00, "Soneri Bank": 775855.23}';
  -- ledger minus record: the ledger still holds what the bank has paid out on
  -- a payslip not yet posted (Shayan) or posted to the wrong account (Roshan).
  v_want constant jsonb := '{"Askari Bank": 114500.00, "BOAJK": 38000.00, "Allied Bank": 0, "Soneri Bank": 0}';
  v_total numeric := 0; v_removed numeric;
begin
  if exists (select 1 from public.opening_balance_batches
              where company_id = v_co and description like '0544%') then
    raise notice '0544: already applied.';
    return;
  end if;

  select id into v_obe from public.chart_of_accounts where company_id = v_co and system_key = 'opening_balance_equity';
  v_ho := public.head_office_region(v_co);
  if v_obe is null then raise exception '0544 REFUSED: no Opening Balance Equity account.'; end if;
  if public.ledger_cutover_posted(v_co) then raise exception '0544 REFUSED: the cutover has posted; bank openings belong in it.'; end if;
  if (select count(*) from public.bank_accounts where company_id = v_co) <> 4 then
    raise exception '0544 REFUSED: expected the four banks named in the header.';
  end if;
  -- The one August bank entry the Askari figure allows for, and no other.
  if (select count(*) from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
       where je.company_id = v_co and je.entry_date <= '2026-08-31'
         and jl.account_id in (select public.bank_account_gl(v_co, b.id) from public.bank_accounts b where b.company_id = v_co)) <> 1 then
    raise exception '0544 REFUSED: the August bank entries are not the single 26,000 Askari advance this opening allows for.';
  end if;

  -- ── 1. the batch, posted ────────────────────────────────────────────────────
  insert into public.opening_balance_batches (company_id, as_of_date, description, status)
  values (v_co, '2026-08-01', '0544: bank balances before the ledger began (1 August 2026)', 'draft')
  returning id into v_batch;

  for r in select b.id, b.bank_name, public.bank_account_gl(v_co, b.id) gl from public.bank_accounts b where b.company_id = v_co loop
    if not (v_open ? r.bank_name) then raise exception '0544 REFUSED: unexpected bank %.', r.bank_name; end if;
    insert into public.opening_balance_lines (batch_id, account_id, debit, credit, notes)
    values (v_batch, r.gl, (v_open ->> r.bank_name)::numeric, 0, 'Held before the ledger began');
    v_total := v_total + (v_open ->> r.bank_name)::numeric;
  end loop;
  insert into public.opening_balance_lines (batch_id, account_id, debit, credit, notes)
  values (v_batch, v_obe, 0, v_total, 'Bank balances before the ledger began');

  if (select difference from public.opening_batch_totals(v_batch)) <> 0 then
    raise exception '0544 REFUSED: the batch does not balance.';
  end if;

  select jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.debit, 'credit', l.credit,
                                      'region', coalesce(l.branch_id, v_ho)))
    into v_lines from public.opening_balance_lines l where l.batch_id = v_batch;
  v_entry := public.post_journal(v_co, '2026-08-01', '0544: bank balances before the ledger began',
                                 'opening_balance_batches', v_batch, false, v_lines, v_ho);
  update public.opening_balance_batches
     set status = 'posted', posted_at = now(), journal_entry_id = v_entry, updated_at = now()
   where id = v_batch;

  -- ── 2. the draft batch gives up its bank lines ──────────────────────────────
  select coalesce(sum(l.debit), 0) into v_removed
    from public.opening_balance_lines l
   where l.batch_id = v_draft
     and l.account_id in (select public.bank_account_gl(v_co, b.id) from public.bank_accounts b where b.company_id = v_co);
  if abs(v_removed - 7471619.23) > 0.005 then
    raise exception '0544 REFUSED: the draft batch''s bank lines total %, not the 7,471,619.23 expected.', v_removed;
  end if;
  delete from public.opening_balance_lines l
   where l.batch_id = v_draft
     and l.account_id in (select public.bank_account_gl(v_co, b.id) from public.bank_accounts b where b.company_id = v_co);
  update public.opening_balance_lines set credit = credit - v_removed
   where batch_id = v_draft and account_id = v_obe;
  update public.opening_balance_batches
     set description = coalesce(description || ' — ', '') || 'bank lines removed by 0544 (posted 1 Aug)', updated_at = now()
   where id = v_draft;

  -- ── asserts ─────────────────────────────────────────────────────────────────
  for r in select account_name, difference from public.bank_held_operational(v_co) loop
    if not (v_want ? r.account_name) then
      v_bad := v_bad || format('%s unexpected; ', r.account_name);
    elsif abs(r.difference - (v_want ->> r.account_name)::numeric) > 0.005 then
      v_bad := v_bad || format('%s off by %s (expected %s); ', r.account_name, r.difference, v_want ->> r.account_name);
    end if;
  end loop;
  if v_bad <> '' then raise exception '0544 REFUSED: %', v_bad; end if;

  if (select difference from public.opening_batch_totals(v_draft)) <> 0 then
    raise exception '0544 REFUSED: the draft batch no longer balances.';
  end if;
  if exists (select 1 from public.opening_balance_lines l where l.batch_id = v_draft
              and l.account_id in (select public.bank_account_gl(v_co, b.id) from public.bank_accounts b where b.company_id = v_co)) then
    raise exception '0544 REFUSED: the draft batch still carries a bank line.';
  end if;
  if public.ledger_cutover_posted(v_co) then
    raise exception '0544 REFUSED: this was taken for the cutover.';
  end if;
  if public.ledger_start_date(v_co) <> '2026-08-01' then
    raise exception '0544 REFUSED: the ledger now starts on %, not 1 August.', public.ledger_start_date(v_co);
  end if;

  raise notice '0544: banks opened at % in all; Askari 114,500 and BOAJK 38,000 left, each named.', v_total;
end $mig$;
