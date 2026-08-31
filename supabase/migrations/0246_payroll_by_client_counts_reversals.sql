-- 0246 — ledger_payroll_by_client returns ZERO. Client payroll cost is absent
-- from every report that reads it.
--
-- DEV ONLY. Shipped alone, ahead of the reversal-status refactor it belongs to,
-- because it is a live defect and burying it inside a refactor would hide it in
-- the log.
--
-- THE DEFECT
--
-- The function filtered `je.status = 'posted'`. A reversing pair is one entry
-- marked 'reversed' and one reversal entry which is itself 'posted'. So the
-- filter EXCLUDED the reversed original and INCLUDED its reversal — exactly one
-- side of a pair that is only meaningful as a pair.
--
-- On the sandbox ledger every live original is matched by a reversal whose
-- original is marked 'reversed', so the two sides cancel and the function
-- returns 0.00 for every month:
--
--   period      as written    correct     cross-check (live originals)
--   2026-06-01       0.00    127,600.00        127,600.00
--   2026-07-01       0.00  1,224,114.00      1,224,114.00
--   total            0.00  1,351,714.00      1,351,714.00
--
-- Confirmed by calling it rather than by reading it:
--   ledger_payroll_by_client(<sandbox>, '2026-07-01')
--     -> 3 rows, total 0.00        (correct: 1,224,114.00)
--
-- It returns rows. It returns the right CLIENTS. Every cost is zero. That is
-- the shape that makes this dangerous: it does not look like an error, it looks
-- like clients with no payroll.
--
-- CORRECTION TO THE FIRST MEASUREMENT. I first reported this as -1,230,566
-- against +1,351,714, an error of 2,582,280 with an inverted sign. That was
-- measured with the wrong account key — `opex_office_salaries`, which this
-- function does not use — and without the `client_id is not null` filter the
-- function applies. Measured against the deployed predicate the answer is
-- simpler and worse: not a wrong number, no number at all.
--
-- WHY DROPPING THE FILTER IS THE FIX, NOT A WIDENING
--
-- In double entry a reversal is not an erasure. Both entries stay and they net.
-- Fourteen of the sixteen functions that touch journal_entries already ignore
-- status, including ledger_checks and every regional P&L, and so does the
-- trial-balance screen. This function was the outlier.
--
-- With no status filter, a reversed original and its reversal both appear and
-- sum to zero, contributing nothing — which is the correct treatment — while a
-- live original contributes its full cost.
--
-- WHY IT MATTERS BEYOND THIS FUNCTION
--
-- ledger_payroll_by_client is payroll cost attributed per client. It feeds
-- client Net Cash and therefore partner remuneration — the F4 waterfall. A
-- silent zero there understates cost and overstates every partner's share.

create or replace function public.ledger_payroll_by_client(p_company_id uuid, p_period_month date)
returns table(client_id uuid, cost numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  perform public.assert_same_company(p_company_id);
  return query
  select jl.client_id, round(sum(jl.debit - jl.credit), 2)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and je.source_table = 'payslips'
     -- NO STATUS FILTER, DELIBERATELY. A reversed entry and its reversal both
     -- belong in the sum: together they net to zero, which is what "reversed"
     -- means. Filtering to 'posted' keeps the reversal and drops the original,
     -- counting one side of a pair. Do not reintroduce it.
     and je.posting_period = date_trunc('month', p_period_month)::date
     and a.system_key in ('cos_payroll', 'opex_office_payroll')
     and jl.client_id is not null
   group by jl.client_id;
end
$function$;

comment on function public.ledger_payroll_by_client(uuid, date) is
  'Payroll cost per client for a month, read from the ledger. Deliberately does NOT filter journal_entries.status: a reversal and its original both belong in the sum and net to zero. Filtering to ''posted'' kept the reversal and dropped the original and made this function return 0.00 for every month — see 0246.';

-- ---------------------------------------------------------------------------
-- Verification. Two INDEPENDENT computations must agree with the function, and
-- the agreed figure must be non-zero — otherwise all three agreeing at nothing
-- would pass.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_period date;
      v_fn numeric; v_all numeric; v_orig numeric; v_old numeric;
    begin
      select je.company_id, je.posting_period into v_co, v_period
        from public.journal_entries je
       where je.source_table = 'payslips'
       group by je.company_id, je.posting_period
       order by count(*) desc
       limit 1;
      if v_co is null then
        raise exception '0246 cannot self-test: no payslip journal entries anywhere';
      end if;
      select p.id into v_p from public.profiles p where p.company_id = v_co limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      -- 1. What the function now returns.
      select coalesce(sum(cost), 0) into v_fn
        from public.ledger_payroll_by_client(v_co, v_period);

      -- 2. Independent computation A: every line, reversals netting naturally.
      select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_all
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
        join public.chart_of_accounts a on a.id = jl.account_id
       where je.company_id = v_co and je.source_table = 'payslips'
         and je.posting_period = v_period
         and a.system_key in ('cos_payroll', 'opex_office_payroll')
         and jl.client_id is not null;

      -- 3. Independent computation B: live originals only — reversals AND the
      -- entries they reverse both excluded. Arrives at the same figure by a
      -- different route, which is what makes the agreement evidence.
      select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_orig
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
        join public.chart_of_accounts a on a.id = jl.account_id
       where je.company_id = v_co and je.source_table = 'payslips'
         and je.posting_period = v_period
         and a.system_key in ('cos_payroll', 'opex_office_payroll')
         and jl.client_id is not null
         and not je.is_reversal
         and not exists (select 1 from public.journal_entries r
                          where r.reversal_of_entry_id = je.id);

      -- 4. What the OLD predicate would have returned, so the fix is shown to
      -- have changed something rather than asserted to have.
      select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_old
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
        join public.chart_of_accounts a on a.id = jl.account_id
       where je.company_id = v_co and je.source_table = 'payslips'
         and je.posting_period = v_period
         and a.system_key in ('cos_payroll', 'opex_office_payroll')
         and jl.client_id is not null
         and je.status = 'posted';

      if v_all = 0 then
        raise exception
          '0246 self-test is VACUOUS: the corrected total for % is zero, so all comparisons hold trivially',
          v_period;
      end if;

      if v_fn is distinct from v_all then
        raise exception '0246 FAILED: function returns % but computation A gives %', v_fn, v_all;
      end if;

      if v_fn is distinct from v_orig then
        raise exception '0246 FAILED: function returns % but computation B (live originals) gives %', v_fn, v_orig;
      end if;

      if v_old = v_fn then
        raise exception
          '0246 SUSPECT: the old predicate gives the same answer (%) as the new one for %, so this data cannot demonstrate the fix',
          v_old, v_period;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0246 verification failed: %', v_outcome;
  end if;
end
$verify$;
