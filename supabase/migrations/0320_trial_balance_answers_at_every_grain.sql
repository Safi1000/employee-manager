-- 0320 — the trial balance answers at every grain the screen asks for.
--
-- 0319 gave `public.trial_balance` a period, and the screen reads it. But the
-- view's grain is account x branch x period, and the screen offers "all
-- regions" and "all periods". In those combinations the branch rows and the
-- period rows had to be added together somewhere, and that somewhere was the
-- browser.
--
-- It was a small sum — a handful of pre-aggregated rows per account, not the
-- 1,304 raw journal lines the old screen pulled. That is exactly why it is
-- worth removing now. It is still a second implementation of a total, and in
-- six months nobody will remember it was the small acceptable one. This is the
-- screen whose entire purpose is that the ledger answers.
--
-- WHY A FUNCTION AND NOT A SECOND VIEW.
-- The screen has four combinations: (a period | all periods) x (a region | all
-- regions). A consolidated view answers one of them, and a view per
-- combination is four implementations of one sum. Two nullable parameters
-- answer all four from one body.
--
-- WHY IT IS NOT SECURITY DEFINER.
-- It reads `public.trial_balance`, which is `security_invoker`, so the caller's
-- RLS on journal_lines and journal_entries decides what it can see. A DEFINER
-- function would have to re-implement that boundary and would land in
-- `tenant_guard_gaps()` as a uuid parameter needing a guard — a guard that
-- exists only because the function took away the one RLS already provided.
-- The absence of `security definer` is load-bearing, so the migration asserts
-- it rather than trusting that nobody adds it later.
--
-- A NULL p_company_id RETURNS NOTHING, not everything: `company_id = null` is
-- null, never true. That is asserted below too, because "the filter is
-- null-safe by construction" is the kind of claim that stops being true when
-- someone rewrites the predicate.

create or replace function public.trial_balance_for(
  p_company_id uuid,
  p_period date default null,
  p_branch_id uuid default null
)
returns table (
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  parent_id uuid,
  total_debit numeric,
  total_credit numeric,
  net_debit numeric
)
language sql
stable
as $fn$
  -- Every figure is a sum of the view's own columns. Nothing here reaches past
  -- trial_balance to journal_lines: 0299 made that view the single source and
  -- this function is a reader of it, not a second computation of it.
  select t.account_id,
         t.account_code,
         t.account_name,
         t.account_type,
         t.parent_id,
         sum(t.total_debit),
         sum(t.total_credit),
         sum(t.net_debit)
    from public.trial_balance t
   where t.company_id = p_company_id
     and (p_period is null or t.posting_period = p_period)
     and (p_branch_id is null or t.branch_id = p_branch_id)
   group by t.account_id, t.account_code, t.account_name, t.account_type, t.parent_id
   order by t.account_code
$fn$;

comment on function public.trial_balance_for(uuid, date, uuid) is
  '0320: the trial balance at whichever grain the caller asks for. p_period null means every period, p_branch_id null means every region. Reads public.trial_balance (0299/0319) and sums its columns — it is a reader of the single source, not a second implementation. Deliberately SECURITY INVOKER: the view is security_invoker, so the caller RLS is the tenant boundary.';

grant execute on function public.trial_balance_for(uuid, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Proof. The function must agree with the view it reads, at all four grains,
-- for real data — and the proof must fail if there is no real data to compare.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_company uuid;
  v_period date;
  v_branch uuid;
  v_rows int;
  v_diff int;
  v_leak int;
begin
  if (select prosecdef from pg_proc where oid = 'public.trial_balance_for(uuid,date,uuid)'::regprocedure) then
    raise exception '0320 FAILED: trial_balance_for is SECURITY DEFINER — it would bypass the RLS that is its only tenant boundary';
  end if;

  -- The company with the most ledger rows, so the comparison has something to
  -- compare. Picking "the first company" is the 0296 defect: a fixture that
  -- selects rows it did not create passes wherever it was written.
  select company_id into v_company
    from public.trial_balance
   group by company_id
   order by count(*) desc
   limit 1;

  if v_company is null then
    raise exception '0320 FAILED: no company has any trial_balance rows, so nothing here was exercised';
  end if;

  select posting_period into v_period
    from public.trial_balance where company_id = v_company
   group by posting_period order by count(*) desc limit 1;

  select branch_id into v_branch
    from public.trial_balance
   where company_id = v_company and branch_id is not null
   group by branch_id order by count(*) desc limit 1;

  if v_period is null or v_branch is null then
    raise exception '0320 FAILED: the chosen company has no period or no branch to test with (period %, branch %)', v_period, v_branch;
  end if;

  -- Grain 1: all periods, all regions.
  select count(*) into v_diff
    from public.trial_balance_for(v_company) f
    full join (
      select account_id, sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
        from public.trial_balance where company_id = v_company group by account_id
    ) v on v.account_id = f.account_id
   where f.account_id is null or v.account_id is null
      or f.total_debit is distinct from v.dr
      or f.total_credit is distinct from v.cr
      or f.net_debit is distinct from v.nd;
  if v_diff <> 0 then
    raise exception '0320 FAILED: % accounts disagree at (all periods, all regions)', v_diff;
  end if;

  -- Grain 2: one period, all regions.
  select count(*) into v_diff
    from public.trial_balance_for(v_company, v_period) f
    full join (
      select account_id, sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
        from public.trial_balance
       where company_id = v_company and posting_period = v_period
       group by account_id
    ) v on v.account_id = f.account_id
   where f.account_id is null or v.account_id is null
      or f.total_debit is distinct from v.dr
      or f.total_credit is distinct from v.cr
      or f.net_debit is distinct from v.nd;
  if v_diff <> 0 then
    raise exception '0320 FAILED: % accounts disagree at (period %, all regions)', v_diff, v_period;
  end if;

  -- Grain 3: all periods, one region.
  select count(*) into v_diff
    from public.trial_balance_for(v_company, null, v_branch) f
    full join (
      select account_id, sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
        from public.trial_balance
       where company_id = v_company and branch_id = v_branch
       group by account_id
    ) v on v.account_id = f.account_id
   where f.account_id is null or v.account_id is null
      or f.total_debit is distinct from v.dr
      or f.total_credit is distinct from v.cr
      or f.net_debit is distinct from v.nd;
  if v_diff <> 0 then
    raise exception '0320 FAILED: % accounts disagree at (all periods, region %)', v_diff, v_branch;
  end if;

  -- Grain 4: one period, one region.
  select count(*) into v_diff
    from public.trial_balance_for(v_company, v_period, v_branch) f
    full join (
      select account_id, sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
        from public.trial_balance
       where company_id = v_company and posting_period = v_period and branch_id = v_branch
       group by account_id
    ) v on v.account_id = f.account_id
   where f.account_id is null or v.account_id is null
      or f.total_debit is distinct from v.dr
      or f.total_credit is distinct from v.cr
      or f.net_debit is distinct from v.nd;
  if v_diff <> 0 then
    raise exception '0320 FAILED: % accounts disagree at (period %, region %)', v_diff, v_period, v_branch;
  end if;

  -- Vacuity. Four grains that all return nothing agree with each other
  -- perfectly and prove nothing (report 9.6). The narrowest grain is the one
  -- that could plausibly be empty, so it is the one that has to be non-empty.
  select count(*) into v_rows
    from public.trial_balance_for(v_company, v_period, v_branch);
  if v_rows = 0 then
    raise exception '0320 FAILED: the narrowest grain returned no rows, so the four comparisons above were between empty sets';
  end if;

  -- A null company must return nothing, not everything.
  select count(*) into v_leak from public.trial_balance_for(null);
  if v_leak <> 0 then
    raise exception '0320 FAILED: a null p_company_id returned % rows — the company filter is not null-safe', v_leak;
  end if;

  raise notice '0320 OK: four grains agree with the view, narrowest grain has % accounts', v_rows;
end
$proof$;
