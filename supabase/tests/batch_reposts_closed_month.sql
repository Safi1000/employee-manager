-- supabase/tests/batch_reposts_closed_month.sql
--
-- Guards 0250, and asserts that the closed-period branch of
-- reverse_journal_for_source (0249) is UNREACHABLE from the three month-batch
-- RPCs.
--
-- WHY THESE THREE REFUSE RATHER THAN ADJUST
--
-- repost_payslip_accruals_for_month, run_ho_cost_allocation and
-- accrue_bonus_reserve do not post a delta. They reverse and repost an ENTIRE
-- month. Allowing that against a closed period would move the whole of July's
-- payroll expense into August and destroy A4, the matching A4 exists for,
-- July's regional P&L and every partner share computed on July.
--
-- A prior-period adjustment posts the DIFFERENCE and leaves the original alone.
-- A reverse-and-repost moves everything. Only the first belongs in the current
-- period, and it must not be reachable by accident through a repost path.
--
-- WHAT "UNREACHABLE" MEANS HERE, AND THE HONEST LIMIT OF THE TEST
--
-- 0249 left a conditional in reverse_journal_for_source that redirects a
-- reversal to the current date when the original period is closed. That branch
-- is defence in depth and these three must never reach it. The suite asserts:
--
--   1. the call is refused, and
--   2. the refusal NAMES THE FUNCTION — meaning it came from the door guard in
--      0250, not from post_journal several frames down, and
--   3. no reversal row was written before the refusal.
--
-- Assertion 2 is the load-bearing one. Assertion 3 is weaker than it looks and
-- is kept for shape rather than strength: a failed call rolls back its own work,
-- so the count reads zero whether the guard fired at the door or deep inside.
-- Verified by removing the door guard and re-running — the call is still
-- refused, by the GENERIC lock message, and still shows zero reversals. Only
-- assertion 2 goes red. Recorded so nobody later reads assertion 3 as proof of
-- ordering that it does not provide.
--
--   BREAK (door guard removed):
--     refused with: "Period for 2026-07-01 is closed. New / edited transactions..."
--     reversals written before refusal: 0
--
-- Runs in a transaction and rolls back via the final raise.

do $suite$
declare
  r          record;
  v_co       uuid;
  v_p        uuid;
  v_month    date;
  v_msg      text;
  v_before   int;
  v_after    int;
  v_n        int;
  v_results  text := '';
  v_checked  int := 0;
  v_fail     int := 0;
  c_expected constant int := 3;
begin
  perform set_config('app.ledger_maintenance', 'off', true);

  select c.id into v_co
    from public.companies c
   where exists (select 1 from public.journal_entries je
                  where je.company_id = c.id and je.source_table = 'payslips')
     and exists (select 1 from public.profiles p
                  where p.company_id = c.id
                    and coalesce(p.role::text,'') <> 'super_super_admin')
   limit 1;
  if v_co is null then
    raise exception 'batch_reposts suite ABORTED: no company has payslip postings and a non-SSA profile';
  end if;

  select p.id into v_p from public.profiles p
   where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_p::text, 'role', 'authenticated')::text, true);

  -- THE PRECONDITION. Without a real tenant identity the period lock returns
  -- early and every refusal below would be absent for the wrong reason.
  if public.current_company_id() is distinct from v_co then
    raise exception 'batch_reposts suite ABORTED: current_company_id() is %, expected %',
      public.current_company_id(), v_co;
  end if;

  select je.posting_period into v_month
    from public.journal_entries je
   where je.company_id = v_co and je.source_table = 'payslips'
   group by je.posting_period order by count(*) desc limit 1;

  -- CONTROL, BEFORE CLOSING ANYTHING. The batch must WORK on an open month, or
  -- a guard that refuses unconditionally would pass every assertion below while
  -- breaking the job.
  begin
    v_n := public.repost_payslip_accruals_for_month(v_co, v_month);
    if v_n < 1 then
      raise exception 'batch_reposts suite ABORTED: open-month control reposted % payslips, so the closed-month result proves nothing', v_n;
    end if;
    v_results := v_results || format(E'CONTROL  open month %s: reposted %s payslip(s)\n', v_month, v_n);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'batch_reposts suite ABORTED%' then raise; end if;
    raise exception 'batch_reposts suite ABORTED: the batch fails on an OPEN month (%)', v_msg;
  end;

  insert into public.accounting_periods (company_id, period_month, closed_at)
  values (v_co, v_month, now());
  if not public.is_period_closed(v_co, v_month) then
    raise exception 'batch_reposts suite ABORTED: could not close %', v_month;
  end if;

  for r in select unnest(array['repost_payslip_accruals_for_month',
                               'run_ho_cost_allocation',
                               'accrue_bonus_reserve']) as fn
  loop
    v_checked := v_checked + 1;
    select count(*) into v_before from public.journal_entries
     where company_id = v_co and is_reversal;

    begin
      case r.fn
        when 'repost_payslip_accruals_for_month' then
          perform public.repost_payslip_accruals_for_month(v_co, v_month);
        when 'run_ho_cost_allocation' then
          perform public.run_ho_cost_allocation(v_co, v_month, 'revenue');
        when 'accrue_bonus_reserve' then
          perform public.accrue_bonus_reserve(v_co, v_month);
      end case;
      v_fail := v_fail + 1;
      v_results := v_results || format(E'%s  FAIL  accepted against a closed month\n', r.fn);
    exception when others then
      get stacked diagnostics v_msg = message_text;
      select count(*) into v_after from public.journal_entries
       where company_id = v_co and is_reversal;

      if v_msg not like '%is closed%' then
        v_fail := v_fail + 1;
        v_results := v_results || format(E'%s  FAIL  refused for another reason: %s\n', r.fn, left(v_msg, 60));
      elsif v_msg not like '%' || r.fn || '%' then
        -- Refused, but by the generic lock deep in post_journal rather than by
        -- the door guard. That is 0250 missing from this function.
        v_fail := v_fail + 1;
        v_results := v_results || format(E'%s  FAIL  refused generically, not by name — door guard missing\n', r.fn);
      elsif v_after <> v_before then
        v_fail := v_fail + 1;
        v_results := v_results || format(E'%s  FAIL  refused by name but wrote %s reversal(s) first\n',
                                         r.fn, v_after - v_before);
      else
        v_results := v_results || format(E'%s  PASS  refused by name, 0 reversals written\n', r.fn);
      end if;
    end;
  end loop;

  -- CANARY.
  if v_checked <> c_expected then
    raise exception 'batch_reposts CANARY FAILED: % of % RPCs exercised', v_checked, c_expected;
  end if;

  if v_fail > 0 then
    raise exception E'batch_reposts FAILED (% of %):\n%', v_fail, v_checked, v_results;
  end if;

  raise exception E'batch_reposts: %/% refuse a closed month by name — rolling back deliberately\n%',
    v_checked, c_expected, v_results;
end
$suite$;
