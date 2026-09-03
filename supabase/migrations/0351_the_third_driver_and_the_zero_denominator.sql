-- 0351 — the third apportionment driver, and the month with no invoices.
--
-- ===========================================================================
-- PART A — A DRIVER 0349 MISSED, AND IT IS THE ONE THAT PAYS PEOPLE
-- ===========================================================================
--
-- 0349 moved two apportionment drivers to invoiced revenue: run_ho_cost_allocation
-- (the posting) and client_statement_loaded (the client statement). While
-- building item 5 I read partnership_allocation and found a THIRD, which 0349
-- did not touch and which nothing in the brief named:
--
--     raw as (select ...
--       case when cfg.basis = 'cash' then r.revenue_cash else r.revenue_accrual end
--         as revenue ...)
--     ho  as (select ... sum(greatest(revenue,0)) filter (where not is_ho) as rev_base)
--     adj as (... ho.ho_profit * greatest(raw.revenue,0) / ho.rev_base ...)
--
-- This is head office profit apportioned across regions BY BASIS REVENUE, and
-- it feeds `pl.profit`, which feeds `partner_take`, which is what a regional
-- partner is actually paid. It is the most consequential of the three and it
-- was the one still following the basis.
--
-- Had 0349 shipped alone, a cash-basis partnership run would have spread head
-- office cost by who collected — the exact defect item 1 exists to remove —
-- while the statement beside it spread by who was invoiced. Two screens,
-- reading the same month, disagreeing about the same partner's share.
--
-- `raw.revenue` is used in EXACTLY those two places, both apportionment. It is
-- never returned. So making it invoiced-always is contained and changes no
-- displayed revenue figure.
--
-- ===========================================================================
-- PART B — ITEM 5: THE PREDICATE, REPORTED BEFORE BEING BUILT
-- ===========================================================================
--
-- The brief asked whether "M has no invoiced revenue" is the right predicate,
-- and specifically whether a region with genuinely zero revenue can be told
-- apart from a month whose invoices are not yet raised.
--
-- THEY CAN, AND THE DISTINCTION IS ALREADY IN THE DATA — because the correct
-- predicate is at COMPANY level, not region level:
--
--   rev_base = sum of invoiced revenue across all NON-head-office regions.
--
--   * One region at zero does NOT make rev_base zero. That region simply
--     absorbs no head office cost, through the arithmetic, and the run
--     proceeds. It must not be refused, and it is not.
--   * Every region at zero DOES make rev_base zero. That is the month whose
--     invoices have not been raised.
--
-- So the predicate is not "a region has no revenue" but "there is a pool to
-- spread and nothing to spread it over". Precisely:
--
--     ho_profit <> 0  AND  rev_base <= 0
--
-- And that condition is not new — partnership_allocation ALREADY computes it,
-- as the `UNALLOCATED_HO` row. Today it is reported and the run proceeds
-- anyway, stranding the entire head office pool. Item 5 turns the same
-- condition into a refusal at draft time.
--
-- The zero-pool case is deliberately NOT refused: if head office cost is zero
-- there is nothing to apportion and a zero denominator is harmless.
--
-- WHY THE TWO CAUSES STILL GET DIFFERENT MESSAGES. Both block, because neither
-- can be apportioned — but they need different actions, so the refusal says
-- which it is by asking whether any contract was live in the month:
--
--   contracts live in M, no invoices  -> "invoices have not been raised yet"
--   no contracts live in M            -> "no billable contract was active"
--
-- The first is Shayan's normal timing (September's invoices are raised on
-- 1 October). The second is a real gap someone must look at.

-- ---------------------------------------------------------------------------
-- Part A. Surgery on partnership_allocation.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'case when cfg.basis = ''cash'' then r.revenue_cash else r.revenue_accrual end as revenue';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partnership_allocation';
  if v_def is null then raise exception '0351 REFUSED: partnership_allocation does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0351 REFUSED: the basis-following revenue expression appears % time(s) in partnership_allocation, expected exactly 1.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor,
    'r.revenue_accrual as revenue  -- 0351: INVOICED revenue on both bases. This
           -- value is used ONLY as the head-office apportionment driver (ho.rev_base
           -- and adj.ho_allocated) and is never returned, so making it
           -- basis-independent changes no displayed revenue. Cost apportionment
           -- follows service delivered — see 0349.');

  execute v_new;
  raise notice '0351: partnership_allocation now apportions head office by invoiced revenue on both bases.';
end $$;

-- ---------------------------------------------------------------------------
-- Part B. The refusal, as its own readable predicate.
-- ---------------------------------------------------------------------------
create or replace function public.partnership_run_blocker(p_company_id uuid, p_period date)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_start date := date_trunc('month', p_period)::date;
  v_end   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_pool  numeric;
  v_base  numeric;
  v_live  int;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- profit_accrual, not profit_cash: the question is whether head office
  -- INCURRED cost in the month, which is what has to be apportioned. A pool
  -- that exists on the accrual basis still has to find a home on either basis,
  -- and regional_pl_range has no basis-neutral `profit` column.
  select coalesce(sum(r.profit_accrual) filter (where coalesce(b.is_head_office, false)), 0),
         coalesce(sum(greatest(r.revenue_accrual, 0)) filter (where not coalesce(b.is_head_office, false)), 0)
    into v_pool, v_base
    from public.regional_pl_range(v_start, v_end) r
    left join public.branches b on b.id = r.branch_id;

  -- Nothing to apportion: a zero denominator cannot do any harm.
  if coalesce(v_pool, 0) = 0 then return null; end if;
  if coalesce(v_base, 0) > 0 then return null; end if;

  -- There IS a pool and nothing to spread it over. Say which cause.
  select count(*) into v_live
    from public.contracts c
    join public.clients cl on cl.id = c.client_id
   where cl.company_id = p_company_id
     and c.status <> 'draft'
     and c.start_date <= v_end
     and (c.end_date is null or c.end_date >= v_start)
     and (c.termination_date is null or c.termination_date >= v_start);

  if v_live > 0 then
    return to_char(v_start, 'FMMonth YYYY') || '''s invoices have not been raised; the head office pool of '
        || to_char(v_pool, 'FM999,999,999.00') || ' cannot be apportioned. '
        || v_live || ' contract(s) were live that month, so invoiced revenue is expected — raise the invoices, then run the allocation.';
  end if;

  return 'No billable contract was active in ' || to_char(v_start, 'FMMonth YYYY')
      || ', so there is no invoiced revenue to apportion the head office pool of '
      || to_char(v_pool, 'FM999,999,999.00') || ' over. This is not a timing problem — nothing was billed at all.';
end;
$fn$;

comment on function public.partnership_run_blocker(uuid, date) is
  '0351 (item 5): NULL when a partnership run for the month can be drafted; otherwise the reason it cannot. Refuses only when there IS a head office pool AND total invoiced revenue across non-HO regions is zero — a single region with no revenue is fine and absorbs nothing through the arithmetic. Distinguishes "invoices not raised yet" from "nothing was billable" by whether any contract was live in the month.';

revoke execute on function public.partnership_run_blocker(uuid, date) from public, anon;
grant execute on function public.partnership_run_blocker(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Wire it into the draft. Surgery: run_profit_allocation is written by 0282 and
-- amended since.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'begin v_user := auth.uid(); exception when others then v_user := null; end;';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_profit_allocation';
  if v_def is null then raise exception '0351 REFUSED: run_profit_allocation does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0351 REFUSED: the auth.uid anchor appears % time(s) in run_profit_allocation, expected 1.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor,
    '-- 0351 (item 5). A month whose invoices have not been raised has a zero
  -- denominator for the head-office apportionment. Drafting it would strand the
  -- whole pool in UNALLOCATED_HO and hand every regional partner a share
  -- computed as though head office cost did not exist.
  declare v_block text;
  begin
    v_block := public.partnership_run_blocker(p_company_id, v_month);
    if v_block is not null then
      raise exception ''%'', v_block using errcode = ''P0001'';
    end if;
  end;

  ' || v_anchor);

  execute v_new;
  raise notice '0351: run_profit_allocation refuses a month with a pool and no invoiced revenue.';
end $$;

-- ---------------------------------------------------------------------------
-- Probe. The predicate must refuse the right thing and permit the right thing.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_msg   text;
begin
  select id into v_co from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_co is null then select id into v_co from public.companies order by created_at limit 1; end if;
  if v_co is null then raise notice '0351: no company to probe; skipped.'; return; end if;

  -- Whatever this database's current month looks like, the blocker must either
  -- return NULL (drafting is possible) or a message that names the month. A
  -- blocker returning a blank string would refuse with no reason, which is the
  -- failure worth catching.
  v_msg := public.partnership_run_blocker(v_co, current_date);
  if v_msg is not null and length(btrim(v_msg)) = 0 then
    raise exception '0351 FAILED: the blocker refused with an empty reason.';
  end if;

  if v_msg is null then
    raise notice '0351: current month is drawable (no head office pool, or invoiced revenue exists).';
  else
    raise notice '0351: current month would be refused — %', v_msg;
  end if;
end $$;
