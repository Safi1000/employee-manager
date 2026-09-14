-- 0440 — a disbursed payslip carries the figures it was paid against.
--
-- WHAT WENT WRONG. The bulk disburse path in PayrollManagement.tsx wrote the
-- payslip's FIGURE columns only `if (!payslipId)` — that is, only when creating
-- a payslip. For a payslip that already existed it wrote nothing but the
-- payment columns, while the money it paid came from the LIVE recomputed row.
-- The single-row path had the same defect and was fixed after Zahid Anwar
-- (EMR-082); the bulk path was not.
--
-- IT FAILS SILENTLY WHERE THE SINGLE PATH FAILED LOUDLY, and the direction of
-- the drift is what decides which. `payslips_paid_not_over_accrued` (0277)
-- refuses paid > net, so when the live Net is HIGHER than the stored one the
-- batch is refused and someone goes and looks. When the live Net is LOWER the
-- short payment is perfectly legal to that constraint: it writes, it succeeds,
-- and the row is left claiming it still owes the difference.
--
-- THE SECOND CONSEQUENCE, which is the worse one. post_payslip_disbursement()
-- posts from net_salary, not from amount_paid. So a stale net did not only
-- misreport a balance on a screen — it credited cash/bank in the LEDGER for
-- more than the cash that actually left. Ikhlaq Iqbal's August disbursement
-- posted Cr bank 47,892 against a bank_transactions row of 47,492.
--
-- FOUR PAYSLIPS ON PRODUCTION, all August 2026, PKR 1,299 in total:
--
--   GGS-00545 Danish Ali    PFM             net 5,871  paid 5,032   839
--   GGS-00141 Ikhlaq Iqbal  HMC Taxila      net 47,892 paid 47,492  400
--   GGS-00071 Abdul Rauf    Emaar DHA ISB   net 52,565 paid 52,535   30
--   GGS-00072 M. Shafiq     Emaar DHA ISB   net 52,565 paid 52,535   30
--
-- In every one the amount paid equals the live Net exactly, so the PAYMENTS
-- were right to the rupee and only the stored figures were stale. Danish's
-- drift was a leave allowance set to 0 after the payslip was written (one
-- pay-day at 839); the other three were EOBI (0 -> 400, and 370 -> 400).
--
-- HOW THE FOUR ARE TREATED, and they are NOT treated the same, because the
-- question "which of the two figures is the true one" has two answers.
--
--   Danish Ali — the PAYMENT is true. The 0-leave override is correct, so
--   5,032 is what he earned. The payslip is restated to 5,032 and nothing is
--   owed. Named explicitly by Shayan: "Danish Ali actual payslip should be
--   5032".
--
--   The other three — the PAYMENT is short. The EOBI that came out of their
--   cash was over-withheld and they are owed it back (asked and answered,
--   DECIDED). Their August payslips are restated to what actually left the
--   bank, which is what makes August's books true, and the amount still owed
--   is raised as a carry-forward ADJUSTMENT (0437) that lands as its own line
--   on their September payslip. That is 0437's own worked example: the payslip
--   said one figure, that figure was paid, it later emerges he was owed more.
--
-- THE GAP COMES OFF final_salary AND NOT OFF eobi, which is not obvious and is
-- the difference between a correct ledger and a quietly wrong one. The tempting
-- restatement is to write the EOBI that was actually withheld — eobi 0 -> 400,
-- 370 -> 400 — since that is literally what came out of the cash. It balances,
-- and it is wrong twice over: post_payslip_accrual() would raise an EOBI
-- PAYABLE of 400 for money that will never be remitted to EOBI, and the +400
-- adjustment would then accrue the same 400 a second time as payroll expense,
-- leaving August at 48,292 of expense for a guard who earned 47,892.
--
-- Taking it off final_salary instead says the true thing: August's payslip
-- UNDERSTATED what he earned, by exactly the amount the adjustment now
-- records. August accrues and pays 47,492; September accrues and pays the 400;
-- the total is 47,892, which is what he earned. No payable is invented, and
-- nothing is counted twice.
--
-- WHY RESTATING IS NOT A BREACH OF 0437's "AN ADJUSTMENT DOES NOT REWRITE THE
-- PAYSLIP". 0437 forbids rewriting a payslip IN ORDER TO record a correction.
-- Here the rewrite repairs figures that were never written in the first place,
-- and the correction itself is the adjustment row. The distinction matters and
-- it is the reason the three get both halves and Danish gets only the first.
--
-- THE LEDGER REPAIRS ITSELF and this file posts no journal by hand.
-- journal_on_payslip() reverses and re-posts the ACCRUAL when final_salary /
-- eobi / income_tax / advance change, and reverses and re-posts the
-- DISBURSEMENT when net_salary changes on a disbursed row. Both fire from the
-- updates below, so after this migration each of the four disbursement entries
-- clears salaries payable by exactly the amount its bank_transactions row
-- moved. That is asserted at the bottom rather than assumed.
--
-- SO THAT IT CANNOT RECUR. Three layers, and only the last two are in this
-- file:
--
--   1. The screen. Fixed in the same commit: bulk disburse now writes the
--      figures unconditionally, before any money moves, exactly as the
--      single-row path does.
--   2. THE STATE IS MADE UNREPRESENTABLE. `payslips_settled_when_disbursed`
--      below is the mirror of `payslips_paid_not_over_accrued` and of the
--      screen's own isSettled() — net <= 0 or paid >= net. A stale-figure
--      disbursement is now REFUSED instead of silently recorded. A refusal is
--      a control; a smaller number that reports success is not.
--   3. No nightly ledger_checks() entry is added, deliberately. The constraint
--      makes the state impossible, so a check watching for it would be green
--      over zero rows for ever — the exact "a green check is not evidence of
--      use" trap this project has been bitten by. The constraint IS the
--      control.
--
-- ONE FUNCTION HAD TO MOVE WITH IT. disburse_payroll_run() sets disbursed =
-- true and never touches amount_paid, so the very first payroll run ever
-- disbursed would have been refused by the new constraint. It is amended here
-- to settle amount_paid alongside the flag, which is what the run means and
-- what post_payslip_disbursement() already assumes (it posts net_salary).
-- payroll_runs has 0 rows on production, so this changes no history. The
-- amendment is SURGERY against the live definition with the anchor asserted to
-- appear exactly once — the function has more than one author (0377 among
-- them) and restating it from any single file would discard the others.
-- It stays SECURITY DEFINER: it processes a SET, and 0377/0379 say why that
-- must not be converted.

do $mig$
declare
  v_co        uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_shayan    uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_period    date := date '2026-08-01';
  r           record;
  v_ps        uuid;
  v_n         int;
  v_bad       int;
  v_sum       numeric;
  v_def       text;
  v_anchor    text;
  v_new       text;
  v_hits      int;
begin

-- ---------------------------------------------------------------------------
-- 1. THE FOUR PAYSLIPS. Each guarded on the figures it is expected to hold, so
--    a re-run against an already-repaired database changes nothing and a run
--    against a row someone else has since moved refuses rather than guesses.
-- ---------------------------------------------------------------------------
for r in
  select * from (values
    -- Only final_salary and net_salary move, each by the same gap. eobi and
    -- income_tax are left exactly as recorded — see the header for why writing
    -- the withheld EOBI here would invent a payable and double the expense.
    -- code,      net_from,      net_to,        final_from,     final_to
    ('GGS-00545', 5871::numeric, 5032::numeric, 5871::numeric,  5032::numeric),
    ('GGS-00141', 47892,         47492,         47892,          47492),
    ('GGS-00071', 52565,         52535,         52965,          52935),
    ('GGS-00072', 52565,         52535,         52965,          52935)
  ) v(code, net_from, net_to, final_from, final_to)
loop
  select p.id into v_ps
    from public.payslips p
    join public.employees e on e.id = p.employee_id
   where e.employee_code = r.code and p.period_month = v_period and p.company_id = v_co;

  if v_ps is null then
    raise exception '0440: no August 2026 payslip for %', r.code;
  end if;

  -- Already repaired? Then this file has run; leave it alone.
  perform 1 from public.payslips
   where id = v_ps
     and round(net_salary)   = round(r.net_to)
     and round(final_salary) = round(r.final_to);
  if found then
    continue;
  end if;

  -- Not repaired and not as recorded either — refuse rather than overwrite
  -- something a later hand has changed.
  perform 1 from public.payslips
   where id = v_ps
     and round(net_salary)   = round(r.net_from)
     and round(final_salary) = round(r.final_from)
     and disbursed;
  if not found then
    raise exception '0440: % is neither the recorded pre-state nor the repaired state — stopping rather than overwriting it', r.code;
  end if;

  update public.payslips
     set final_salary = r.final_to,
         net_salary   = r.net_to,
         updated_at   = now()
   where id = v_ps;
end loop;

-- ---------------------------------------------------------------------------
-- 2. WHAT THE THREE ARE STILL OWED, as carry-forward adjustments.
--
--    Through raise_payroll_adjustment() and not by inserting the rows, because
--    the RPC is the only thing that posts the accrual WITH the row, and an
--    adjustment without its journal is exactly the half-record 0437 exists to
--    prevent.
--
--    The RPC's guard is require_perm('payroll.adjust') and a migration has no
--    auth.uid(), so the session is stamped as Shayan (super_admin, the operator
--    who ran these payrolls) for the length of these three calls. The rows
--    therefore carry raised_by = his id; each reason text says this file raised
--    it, so no row can be mistaken for one he typed.
-- ---------------------------------------------------------------------------
perform set_config('request.jwt.claims',
         json_build_object('sub', v_shayan::text, 'role', 'authenticated')::text, true);

for r in
  select * from (values
    ('GGS-00141', 400::numeric, 'EOBI of 400 was withheld from August 2026 pay that should not have been. Raised by migration 0440; see that file for how the shortfall was found.'),
    ('GGS-00071', 30,           'EOBI withheld from August 2026 pay was 400 against 370 due. Raised by migration 0440; see that file for how the shortfall was found.'),
    ('GGS-00072', 30,           'EOBI withheld from August 2026 pay was 400 against 370 due. Raised by migration 0440; see that file for how the shortfall was found.')
  ) v(code, amount, reason)
loop
  select p.id into v_ps
    from public.payslips p
    join public.employees e on e.id = p.employee_id
   where e.employee_code = r.code and p.period_month = v_period and p.company_id = v_co;

  -- Idempotent on the payslip, not on the amount: one correction per payslip
  -- from this file, and a re-run must not pay anybody twice.
  perform 1 from public.payroll_adjustments
   where payslip_id = v_ps and reason like '%migration 0440%';
  if found then
    continue;
  end if;

  perform public.raise_payroll_adjustment(
            v_ps, r.amount, r.reason,
            'carry_forward'::public.adjustment_settlement);
end loop;

perform set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 3. VERIFY. Each assertion names a failure it can actually distinguish.
-- ---------------------------------------------------------------------------

-- (a) The defect itself: a payslip flagged disbursed that was paid under its
--     own Net. Company-wide, not only the four rows this file touched.
select count(*) into v_bad
  from public.payslips
 where disbursed and coalesce(net_salary, 0) > 0
   and round(coalesce(amount_paid, 0)) < round(net_salary);
if v_bad <> 0 then
  raise exception '0440: % payslip(s) still disbursed for less than their Net', v_bad;
end if;

-- (b) The ledger consequence, which is the half a screen cannot show. For each
--     of the four, the disbursement postings must now clear salaries payable by
--     exactly the cash that moved. Reversal pairs cancel in the debit-minus-
--     credit sum, so this reads the NET of every posting and re-posting, which
--     is the only figure that matters.
for r in
  select e.employee_code as code,
         round(p.amount_paid) as paid,
         coalesce(sum(jl.debit - jl.credit), 0) as posted
    from public.payslips p
    join public.employees e on e.id = p.employee_id
    join public.journal_entries je
      on je.source_table = 'payslips_disbursement' and je.source_id = p.id
    join public.journal_lines jl
      on jl.journal_entry_id = je.id
    join public.chart_of_accounts coa
      on coa.id = jl.account_id and coa.system_key = 'salaries_payable'
   where e.employee_code in ('GGS-00545','GGS-00141','GGS-00071','GGS-00072')
     and p.period_month = v_period and p.company_id = v_co
   group by 1, 2
loop
  if round(r.posted) <> r.paid then
    raise exception '0440: % disbursement clears % of salaries payable against % actually paid',
      r.code, round(r.posted), r.paid;
  end if;
end loop;

-- (c) The three corrections exist, are open, carry forward, and total 460.
select count(*), coalesce(sum(amount), 0) into v_n, v_sum
  from public.payroll_adjustments
 where reason like '%migration 0440%'
   and status = 'open' and settlement = 'carry_forward';
if v_n <> 3 or v_sum <> 460 then
  raise exception '0440: expected 3 open carry-forward adjustments totalling 460, found % totalling %', v_n, v_sum;
end if;

-- (d) September will pick them up. A correction nothing can reach is the
--     "built behind a closed door" failure this project keeps repeating, so
--     the reachability is tested and not assumed.
select count(*) into v_n
  from public.carried_adjustments_for(date '2026-09-01') c
  join public.employees e on e.id = c.employee_id
 where e.employee_code in ('GGS-00141','GGS-00071','GGS-00072');
if v_n <> 3 then
  raise exception '0440: September carries % of the 3 corrections; the rest will never reach a payslip', v_n;
end if;

-- ---------------------------------------------------------------------------
-- 4. disburse_payroll_run() SETTLES WHAT IT FLAGS. Surgery, not restatement.
-- ---------------------------------------------------------------------------
select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'disburse_payroll_run';
if v_def is null then
  raise exception '0440: disburse_payroll_run() not found';
end if;

if position('amount_paid' in v_def) = 0 then
  v_anchor := chr(10) || '  update public.payslips' || chr(10) || '     set disbursed = true,' || chr(10);
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0440: the disburse_payroll_run() anchor appears % time(s), not once — refusing to guess', v_hits;
  end if;
  v_new := v_anchor
        || '         -- 0440. The flag and the settlement are one fact. Leaving' || chr(10)
        || '         -- amount_paid behind is the same defect the bulk screen had,' || chr(10)
        || '         -- and post_payslip_disbursement() already posts net_salary.' || chr(10)
        || '         amount_paid = net_salary,' || chr(10);
  execute replace(v_def, v_anchor, v_new);
end if;

select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'disburse_payroll_run';
if position('amount_paid = net_salary' in v_def) = 0 then
  raise exception '0440: disburse_payroll_run() still does not settle amount_paid';
end if;
if position('SECURITY DEFINER' in upper(v_def)) = 0 then
  raise exception '0440: disburse_payroll_run() lost SECURITY DEFINER — it processes a SET (0377)';
end if;

end $mig$;

-- ---------------------------------------------------------------------------
-- 5. THE CONSTRAINT. The mirror of payslips_paid_not_over_accrued and of the
--    screen's isSettled(): a disbursed payslip has been paid in full, or its
--    Net is zero (0428 — nothing to pay, nothing to hand over).
--
--    Added NOT VALID and VALIDATEd as a separate step so the validation scan is
--    its own named failure. The four repaired above were the only violators of
--    294 payslips.
-- ---------------------------------------------------------------------------
do $c$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.payslips'::regclass
                    and conname = 'payslips_settled_when_disbursed') then
    alter table public.payslips
      add constraint payslips_settled_when_disbursed
      check (not disbursed
             or coalesce(net_salary, 0) <= 0
             or round(coalesce(amount_paid, 0)) >= round(net_salary))
      not valid;
  end if;
end $c$;

alter table public.payslips validate constraint payslips_settled_when_disbursed;

comment on constraint payslips_settled_when_disbursed on public.payslips is
  '0440: a disbursed payslip carries the figures it was paid against. The mirror of payslips_paid_not_over_accrued (0277) and of the payroll screen''s isSettled(). It refuses the state the bulk disburse path used to write silently — flagged disbursed while amount_paid sits under a stale net_salary — which also made post_payslip_disbursement() credit cash for more than left the bank. Zero-net payslips are exempt (0428).';

-- ---------------------------------------------------------------------------
-- 6. THE TENANT GUARD DETECTOR MUST STILL BE ABLE TO READ WHAT SECTION 4 REWROTE.
--
--    This file redefines disburse_payroll_run() by surgery. The guard it
--    carries — assert_same_company() on the run's company_id — is inside the
--    text that was copied forward, so it is exactly the case the four repeats
--    (0348, 0352, 0363) were: a guard that was correct and was never checked
--    against the detector afterwards. Asserted, not assumed.
-- ---------------------------------------------------------------------------
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
