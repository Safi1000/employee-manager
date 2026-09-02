-- 0319 — the ledger views answer the questions the screens ask.
--
-- The trial balance screen must show "the period". public.trial_balance has no
-- period dimension: it groups over all time. The journal screen must filter by
-- period, client and partner, and must say whether an entry HAS BEEN reversed;
-- public.journal_lines_regional carries none of those.
--
-- Without this migration both screens would answer those questions in the
-- browser, which is the defect 0299 removed from the check suite. So the grain
-- moves into the view and the screens keep reading.
--
-- THE REDUCTION CLAIM, stated so it can be falsified:
--   Adding a column to a GROUP BY splits groups; it never changes a SUM taken
--   over all of them. ledger_checks_base is the only reader of trial_balance
--   (post_opening_balances mentions the phrase in prose only, and no view
--   depends on it), and it reads
--       sum(t.total_debit), sum(t.total_credit) where company_id = ...
--   by name, not by position. So 0299's collapse survives.
--
-- That claim is not asserted here as prose. The migration measures the old
-- view, replaces it, measures the new one re-aggregated back to the old grain,
-- and refuses to commit unless every company/account/branch group matches
-- exactly — and unless there was something there to match, because a proof
-- over an empty table proves nothing (report §9.6).


-- ---------------------------------------------------------------------------
-- Step 0. The period dimension has to exist before it can be a grain.
-- ---------------------------------------------------------------------------
do $pre$
declare
  v_null int;
  v_disagree int;
begin
  select count(*) into v_null
    from public.journal_entries where posting_period is null;
  if v_null <> 0 then
    raise exception '0319 FAILED: % journal_entries have a null posting_period; a null group cannot be filtered on a screen', v_null;
  end if;

  -- A reading, not a gate. posting_period is allowed to diverge from
  -- entry_date by policy (advance invoicing will do exactly that), and the
  -- sums below are unchanged either way. It is recorded because a divergence
  -- appearing here for the first time is worth a human noticing.
  select count(*) into v_disagree
    from public.journal_entries
   where posting_period <> date_trunc('month', entry_date)::date;
  raise notice '0319: % entries post to a period other than their entry month', v_disagree;
end
$pre$;

-- ---------------------------------------------------------------------------
-- Step 1. Measure the old views, at their own grain.
-- ---------------------------------------------------------------------------
create temp table _0319_before on commit drop as
select company_id, account_id, branch_id,
       sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
  from public.trial_balance
 group by company_id, account_id, branch_id;

create temp table _0319_lines_before on commit drop as
select count(*) n from public.journal_lines_regional;

-- ---------------------------------------------------------------------------
-- Step 2. Replace the views. Columns are APPENDED — create or replace view
-- requires the existing ones keep their name, type and position.
-- ---------------------------------------------------------------------------
create or replace view public.trial_balance
with (security_invoker = true) as
select je.company_id,
       a.id as account_id,
       a.account_code,
       a.account_name,
       a.account_type,
       a.parent_id,
       jl.branch_id,
       br.name as region_name,
       sum(jl.debit) as total_debit,
       sum(jl.credit) as total_credit,
       sum(jl.debit) - sum(jl.credit) as net_debit,
       je.posting_period
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  join public.chart_of_accounts a on a.id = jl.account_id
  left join public.branches br on br.id = jl.branch_id
 group by je.company_id, a.id, a.account_code, a.account_name, a.account_type,
          a.parent_id, jl.branch_id, br.name, je.posting_period;

comment on view public.trial_balance is
  '0319: grain is company x account x branch x posting_period. The period was added so the trial balance screen can filter on it instead of summing journal_lines in the browser. Summing over all periods reproduces the pre-0319 figure exactly — 0319 proves that rather than asserting it.';

create or replace view public.journal_lines_regional
with (security_invoker = true) as
select jl.id,
       jl.journal_entry_id,
       jl.account_id,
       jl.debit,
       jl.credit,
       jl.branch_id,
       b.name as region_name,
       b.code as region_code,
       b.kind as region_kind,
       je.company_id,
       je.entry_date,
       je.source_table,
       je.source_id,
       je.is_reversal,
       -- appended by 0319
       je.posting_period,
       je.description,
       je.manual,
       je.created_at as entry_created_at,
       je.reversal_of_entry_id,
       -- "has this entry BEEN reversed" is derived from the reversing entry
       -- pointing back at it. 0247 removed the 'reversed' status value so this
       -- question has exactly one answer, and it is not a flag anyone can
       -- forget to set.
       exists (
         select 1 from public.journal_entries r
          where r.reversal_of_entry_id = je.id
       ) as is_reversed,
       jl.client_id,
       jl.partner_id,
       jl.employee_id,
       jl.contract_id,
       jl.cost_center,
       a.account_code,
       a.account_name,
       a.account_type
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id
  join public.chart_of_accounts a on a.id = jl.account_id
  left join public.branches b on b.id = jl.branch_id;

comment on view public.journal_lines_regional is
  '0319: carries period, client, partner, account and both directions of reversal — is_reversal (this entry reverses something) and is_reversed (something reverses this entry, derived from reversal_of_entry_id).';

-- ---------------------------------------------------------------------------
-- Step 3. Prove the reduction. Same pattern as 0299: recompute the old figure
-- by hand and require an exact match.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_base int;
  v_diff int;
  v_after_lines int;
  v_before_lines int;
  v_reversed int;
  v_targets int;
begin
  select count(*) into v_base from _0319_before;
  if v_base = 0 then
    raise exception '0319 FAILED: the before-image is empty, so a match proves nothing';
  end if;

  select count(*) into v_diff
    from (
      select company_id, account_id, branch_id,
             sum(total_debit) dr, sum(total_credit) cr, sum(net_debit) nd
        from public.trial_balance
       group by company_id, account_id, branch_id
    ) a
    full join _0319_before b
      on  b.company_id = a.company_id
      and b.account_id = a.account_id
      and b.branch_id is not distinct from a.branch_id
   where a.company_id is null
      or b.company_id is null
      or a.dr is distinct from b.dr
      or a.cr is distinct from b.cr
      or a.nd is distinct from b.nd;

  if v_diff <> 0 then
    raise exception '0319 FAILED: % account/branch groups changed when the period entered the grain — the reduction is not exact', v_diff;
  end if;

  select n into v_before_lines from _0319_lines_before;
  select count(*) into v_after_lines from public.journal_lines_regional;
  if v_after_lines <> v_before_lines then
    raise exception '0319 FAILED: journal_lines_regional went from % rows to % — the added join drops or duplicates lines', v_before_lines, v_after_lines;
  end if;

  -- is_reversed must name exactly the set of line-carrying entries that
  -- something points at.
  select count(distinct journal_entry_id) into v_reversed
    from public.journal_lines_regional where is_reversed;
  select count(*) into v_targets
    from public.journal_entries e
   where exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = e.id)
     and exists (select 1 from public.journal_lines l where l.journal_entry_id = e.id);
  if v_reversed <> v_targets then
    raise exception '0319 FAILED: is_reversed marks % entries but % are named by a reversal_of_entry_id', v_reversed, v_targets;
  end if;
  if v_targets = 0 then
    raise exception '0319 FAILED: no entry has been reversed, so is_reversed was never exercised';
  end if;

  raise notice '0319 OK: % account/branch groups unchanged, % lines, % reversed entries', v_base, v_after_lines, v_targets;
end
$proof$;
