-- supabase/tests/payroll_by_client.sql
--
-- Guards 0246: ledger_payroll_by_client must count a reversal and the entry it
-- reverses TOGETHER, so they net, and must not filter journal_entries.status.
--
-- WHY THIS SUITE EXISTS
--
-- The function filtered `je.status = 'posted'`. A reversing pair is one entry
-- marked 'reversed' and one reversal entry which is itself 'posted', so the
-- filter dropped the original and kept its reversal — one side of a pair that
-- only means anything as a pair. Both sides cancelled exactly and the function
-- returned 0.00 for every month while still returning the right CLIENTS. It did
-- not look like an error; it looked like clients with no payroll.
--
-- It feeds client Net Cash and therefore partner remuneration, so a silent zero
-- understates cost and overstates every partner's share.
--
-- THE STANDARD OF PROOF
--
-- Two INDEPENDENT computations must agree with the function, reached by
-- different routes:
--
--   A. every line, letting reversals net against their originals naturally
--   B. live originals only — both reversals and the entries they reverse
--      excluded entirely
--
-- A and B agree only if every reversal exactly offsets its original, which is
-- the property under test. One computation restated twice would prove nothing;
-- two routes to the same number is evidence.
--
-- NON-VACUITY, TWICE OVER
--
--   * The agreed figure must be NON-ZERO. Three computations agreeing at zero
--     is exactly the bug this file exists to catch, and it would satisfy every
--     equality assertion.
--   * The OLD predicate must still give a DIFFERENT answer on this data. If it
--     ever agrees, the fixture no longer contains a reversing pair and the
--     suite has stopped demonstrating anything — that is reported as NO
--     DEMONSTRATION, which is not a pass.
--
-- Runs in a transaction and rolls back via the final raise.

do $suite$
declare
  r           record;
  v_p         uuid;
  v_fn        numeric;
  v_all       numeric;
  v_orig      numeric;
  v_old       numeric;
  v_results   text := '';
  v_checked   int := 0;
  v_periods   int := 0;
  v_demo      int := 0;
  v_fail      int := 0;
begin
  -- How many company/period pairs have payslip postings at all. Derived from
  -- the data, not a literal, so a fixture that grows is covered automatically
  -- and one that shrinks to nothing is caught by the canary below.
  select count(*) into v_periods
    from (select je.company_id, je.posting_period
            from public.journal_entries je
           where je.source_table = 'payslips'
           group by je.company_id, je.posting_period) x;

  if v_periods = 0 then
    raise exception 'payroll_by_client suite ABORTED: no payslip journal entries exist, so there is nothing to check';
  end if;

  for r in
    select je.company_id, je.posting_period
      from public.journal_entries je
     where je.source_table = 'payslips'
     group by je.company_id, je.posting_period
     order by je.company_id, je.posting_period
  loop
    -- The function is SECURITY DEFINER and tenant-guarded, so the suite must
    -- act as a member of the company it is asking about.
    select p.id into v_p from public.profiles p where p.company_id = r.company_id limit 1;
    if v_p is null then
      v_results := v_results || format(E'%s  NO PROFILE — cannot call the guarded function\n', r.posting_period);
      continue;
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_p::text, 'role', 'authenticated')::text, true);

    select coalesce(sum(cost), 0) into v_fn
      from public.ledger_payroll_by_client(r.company_id, r.posting_period);

    select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_all
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = r.company_id and je.source_table = 'payslips'
       and je.posting_period = r.posting_period
       and a.system_key in ('cos_payroll', 'opex_office_payroll')
       and jl.client_id is not null;

    select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_orig
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = r.company_id and je.source_table = 'payslips'
       and je.posting_period = r.posting_period
       and a.system_key in ('cos_payroll', 'opex_office_payroll')
       and jl.client_id is not null
       and not je.is_reversal
       and not exists (select 1 from public.journal_entries x
                        where x.reversal_of_entry_id = je.id);

    select coalesce(round(sum(jl.debit - jl.credit), 2), 0) into v_old
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = r.company_id and je.source_table = 'payslips'
       and je.posting_period = r.posting_period
       and a.system_key in ('cos_payroll', 'opex_office_payroll')
       and jl.client_id is not null
       and je.status = 'posted';

    v_checked := v_checked + 1;

    if v_fn is distinct from v_all or v_fn is distinct from v_orig then
      v_fail := v_fail + 1;
      v_results := v_results || format(
        E'%s  FAIL  function=%s  all-lines=%s  live-originals=%s\n',
        r.posting_period, v_fn, v_all, v_orig);
    elsif v_all = 0 then
      v_results := v_results || format(
        E'%s  NO DEMONSTRATION  (corrected total is zero; equalities hold trivially)\n',
        r.posting_period);
    elsif v_old = v_fn then
      v_results := v_results || format(
        E'%s  NO DEMONSTRATION  (old predicate agrees at %s; no reversing pair in this data)\n',
        r.posting_period, v_old);
    else
      v_demo := v_demo + 1;
      v_results := v_results || format(
        E'%s  PASS  %s  (old predicate would give %s)\n',
        r.posting_period, v_fn, v_old);
    end if;
  end loop;

  -- CANARY. Every period the data contains must have been accounted for.
  if v_checked <> v_periods then
    raise exception 'payroll_by_client CANARY FAILED: % period(s) exist but % were checked',
      v_periods, v_checked;
  end if;

  -- At least one period must actually demonstrate the fix, or the suite is
  -- green over data that cannot tell the two predicates apart.
  if v_demo = 0 then
    raise exception
      'payroll_by_client FAILED: % period(s) checked and NONE demonstrates the fix — no reversing pair remains in the fixture:%',
      v_checked, v_results;
  end if;

  if v_fail > 0 then
    raise exception 'payroll_by_client FAILED (% of % periods):%', v_fail, v_checked, v_results;
  end if;

  raise exception E'payroll_by_client: %/% periods pass, % demonstrate the fix — rolling back deliberately\n%',
    v_checked, v_periods, v_demo, v_results;
end
$suite$;
