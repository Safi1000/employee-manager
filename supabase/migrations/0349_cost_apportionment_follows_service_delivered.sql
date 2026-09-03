-- 0349 — cost apportionment follows service delivered, not collection.
--
-- THE POLICY CHANGE. "The driver follows the basis" is replaced by:
--
--     Cost apportionment follows SERVICE DELIVERED. The basis governs what
--     counts as revenue and payment, not how cost is spread.
--
-- Concretely, on BOTH bases:
--   * head office cost apportions to regions by INVOICED revenue
--   * region cost apportions to clients by INVOICED revenue
--
-- Shayan's argument, which is the reason: head office cost is driven by the
-- business done, not by whether the client paid on time. A region that invoiced
-- 10m and collected 3m consumed the same head office support as one that
-- invoiced 10m and collected 10m. Apportioning by receipts makes the second
-- region carry the first's collection problem. One level down, a client who
-- paid absorbs the overhead of one who did not.
--
-- This SUPERSEDES the A10 reading in 0225's header ("revenue basis -> driver is
-- invoiced amount; cash basis -> driver is cash received"). A10's substantive
-- ruling — never guard-days — is untouched and still enforced. What changes is
-- only which of the two revenue measures drives the split on the cash basis.
--
-- ---------------------------------------------------------------------------
-- MEASURED BEFORE APPLYING, and the size of the change is not small.
--
-- Production has NOTHING to measure: 0 invoices, 0 invoice lines, 0
-- ho_allocation_runs, 0 partners. On prod this migration moves no figure that
-- exists today, which is exactly why it lands now, before Shayan adds partners.
--
-- So the before/after was measured on crm-design-dev, SANDBOX TESTING ORG,
-- the only data with invoices and receipts (read-only; nothing was written
-- there). Head office pool apportioned across regions:
--
--   September 2026 — CASH BASIS
--     invoiced:  North 200,000   South 100,000
--     received:  North       1   South 150,000
--
--     driver = cash received (BEFORE)   North  0.0007%   South 99.9993%
--     driver = invoiced      (AFTER)    North 66.6667%   South 33.3333%
--
--   South currently absorbs essentially the ENTIRE head office pool because it
--   collected, while North — which invoiced twice as much — absorbs nothing.
--   That is the defect in one line.
--
--   June and July 2026 — CASH BASIS, and worse
--     received: every region 0.00
--
--   With a cash driver the denominator is zero, `v_total <= 0` fires, and the
--   WHOLE pool is recorded as `unallocated`. Not misallocated — unallocated,
--   every month in which nothing was collected. Under the new driver those
--   months apportion normally: June North 59.25% / South 40.75%, July North
--   52.58% / South 47.42%.
--
--   REVENUE BASIS IS UNCHANGED IN EVERY MONTH, by construction: the driver was
--   already invoiced revenue there. Any difference on the revenue basis would
--   mean this migration did something it was not asked to.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT CHANGE. The `revenue` column of a cash-basis statement is
-- still cash received, the `net` is still computed on the basis chosen, and
-- payroll and direct expenses still resolve on the basis chosen. ONLY the two
-- apportionment ratios move. A cash-basis statement remains a cash-basis
-- statement; it simply stops spreading overhead by who happened to pay.

-- ---------------------------------------------------------------------------
-- Step 1. The driver, named, so the policy is a function and not a parameter
-- someone can pass the wrong value to.
-- ---------------------------------------------------------------------------
create or replace function public.ho_apportionment_driver(
  p_company_id uuid, p_branch_id uuid, p_period date)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $fn$
  -- Deliberately NO basis parameter. 0349: cost apportionment follows service
  -- delivered, so this is invoiced revenue at SERVICE month (A4) whichever
  -- basis the report is run on. If you are about to add a basis argument here,
  -- read 0349's header first — its absence is the policy.
  select coalesce((
    select sum(il.amount)
      from public.invoice_lines il
      join public.invoices i on i.id = il.invoice_id
     where i.company_id = p_company_id
       and i.branch_id = p_branch_id
       and coalesce(i.period_start, i.invoice_date) >= date_trunc('month', p_period)::date
       and coalesce(i.period_start, i.invoice_date) <  (date_trunc('month', p_period) + interval '1 month')::date
  ), 0);
$fn$;

comment on function public.ho_apportionment_driver(uuid, uuid, date) is
  '0349: the head-office apportionment driver — invoiced revenue at service month, on BOTH bases. Replaces the basis-following driver of 0225. Head office cost is driven by business done, not by whether the client paid on time. A10 (never guard-days) is unchanged.';

-- branch_revenue_for_month survives: it is still the right answer to "what did
-- this branch bill / collect in this month", which reports ask. It is simply no
-- longer the apportionment driver.
comment on function public.branch_revenue_for_month(uuid, uuid, date, text) is
  '0225: what a branch billed (revenue basis) or collected (cash basis) in a month. NO LONGER THE APPORTIONMENT DRIVER — 0349 moved that to ho_apportionment_driver, which is invoiced revenue on both bases. Still correct for reporting a branch''s revenue on a chosen basis.';

-- ---------------------------------------------------------------------------
-- Step 2. run_ho_cost_allocation reads the driver instead of the basis.
-- Surgery: 0096 and 0225 have both written this function.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'public.branch_revenue_for_month(p_company_id, b.id, v_month, v_basis)';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_ho_cost_allocation';
  if v_def is null then raise exception '0349 REFUSED: run_ho_cost_allocation does not exist'; end if;

  -- THREE call sites, deliberately: the denominator, the largest-biller tiebreak
  -- and the per-branch numerator. All three must move together — leaving one on
  -- the old driver would apportion a share of a differently-measured whole.
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 3 then
    raise exception
      '0349 REFUSED: the driver call appears % time(s) in run_ho_cost_allocation, expected exactly 3 (denominator, tiebreak, numerator). Do not proceed until this matches — a missed site apportions a share of a different total.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor, 'public.ho_apportionment_driver(p_company_id, b.id, v_month)');
  execute v_new;
  raise notice '0349: run_ho_cost_allocation moved to the invoiced-revenue driver (3 sites).';
end $$;

-- ---------------------------------------------------------------------------
-- Step 3. client_statement_loaded apportions region and HO cost by invoiced
-- revenue too. Surgery: 0282, 0303 and 0305 have all written this function.
--
-- Five edits, each with its own asserted occurrence count. `rev` keeps its
-- meaning (revenue on the chosen basis, which is what the column shows); a new
-- `drv` carries the invoiced figure that does the spreading.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def  text;
  v_new  text;
  v_hits int;

  a_total  text := 'rev_total as (select coalesce(sum(amt), 0) as amt from rev),';
  a_region text := 'select cl.branch_id as b, coalesce(sum(rev.amt), 0) as amt, count(*) as n_clients
      from cl join rev on rev.client_id = cl.id group by cl.branch_id';
  a_rr     text := 'coalesce(rev.amt, 0) / rr.amt';
  a_rt     text := 'coalesce(rev.amt, 0) / rt.amt';
  a_join   text := 'left join rev on rev.client_id = cl.id';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'client_statement_loaded';
  if v_def is null then raise exception '0349 REFUSED: client_statement_loaded does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_total, ''))) / length(a_total);
  if v_hits <> 1 then raise exception '0349 REFUSED: rev_total anchor appears %, expected 1', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_region, ''))) / length(a_region);
  if v_hits <> 1 then raise exception '0349 REFUSED: rev_region anchor appears %, expected 1', v_hits; end if;

  -- Two each: the displayed share column, and the same expression inside net.
  v_hits := (length(v_def) - length(replace(v_def, a_rr, ''))) / length(a_rr);
  if v_hits <> 2 then raise exception '0349 REFUSED: region ratio appears %, expected 2 (column and net)', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_rt, ''))) / length(a_rt);
  if v_hits <> 2 then raise exception '0349 REFUSED: HO ratio appears %, expected 2 (column and net)', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_join, ''))) / length(a_join);
  if v_hits <> 1 then raise exception '0349 REFUSED: rev join anchor appears %, expected 1', v_hits; end if;

  v_new := v_def;

  -- (a) the driver CTE, and rev_total now sums it rather than basis revenue.
  v_new := replace(v_new, a_total,
    '-- 0349. THE APPORTIONMENT DRIVER. `rev` is revenue on the chosen basis and
  -- stays that way — it is what the revenue COLUMN shows. `drv` is invoiced
  -- revenue always, and it is the only thing that spreads cost. Cost follows
  -- service delivered; the basis governs what counts as revenue and payment.
  drv as (
    select cl.id as client_id, coalesce(iv.amt, 0) as amt
      from cl left join iv on iv.client_id = cl.id
  ),
  rev_total as (select coalesce(sum(amt), 0) as amt from drv),');

  -- (b) per-region denominator likewise.
  v_new := replace(v_new, a_region,
    'select cl.branch_id as b, coalesce(sum(drv.amt), 0) as amt, count(*) as n_clients
      from cl join drv on drv.client_id = cl.id group by cl.branch_id');

  -- (c)(d) both ratios, numerator side.
  v_new := replace(v_new, a_rr, 'coalesce(drv.amt, 0) / rr.amt');
  v_new := replace(v_new, a_rt, 'coalesce(drv.amt, 0) / rt.amt');

  -- (e) drv has to be reachable from the select list.
  v_new := replace(v_new, a_join, a_join || '
  left join drv on drv.client_id = cl.id');

  execute v_new;
  raise notice '0349: client_statement_loaded apportions by invoiced revenue on both bases.';
end $$;

-- ---------------------------------------------------------------------------
-- Step 4. Prove it. Rollback probe, on whatever data the database has.
--
-- WHAT IS AND IS NOT EXPECTED TO MATCH, because getting this wrong is easy:
--
--   The POOL is still basis-dependent and must stay so. A cash-basis pool is
--   the head-office cost actually PAID in the month; a revenue-basis pool is
--   the cost incurred. 0349 does not touch that and an assertion that the two
--   pools are equal would be asserting a bug.
--
--   The WEIGHTS are now basis-independent. So the SHARE OF THE POOL each client
--   carries must be identical on both bases, even while the pools differ.
--
-- The probe therefore compares proportions, not amounts.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_start date;
  v_end   date;
  r       record;
  v_n     int := 0;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then raise notice '0349: no company to probe; skipped.'; return; end if;

  v_start := date_trunc('month', current_date)::date;
  v_end   := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;

  for r in
    with rev as (
      select client_id, client_name, ho_share, sum(ho_share) over () as tot
        from public.client_statement_loaded(v_start, v_end, 'revenue', v_co)),
    csh as (
      select client_id, ho_share, sum(ho_share) over () as tot
        from public.client_statement_loaded(v_start, v_end, 'cash', v_co))
    select rev.client_name,
           round(rev.ho_share / nullif(rev.tot, 0), 6) as w_rev,
           round(csh.ho_share / nullif(csh.tot, 0), 6) as w_csh
      from rev join csh on csh.client_id = rev.client_id
     where rev.tot <> 0 and csh.tot <> 0
  loop
    v_n := v_n + 1;
    if r.w_rev is distinct from r.w_csh then
      raise exception
        '0349 FAILED: % carries %%% of the head-office pool on the revenue basis but %%% on the cash basis. The driver is still following the basis.',
        r.client_name, r.w_rev * 100, r.w_csh * 100;
    end if;
  end loop;

  if v_n = 0 then
    raise notice '0349: no client carries a head-office share this month (no pool or no invoiced revenue) — weights not exercised, which is expected on a database with no invoices.';
  else
    raise notice '0349: % client(s) carry identical head-office weights on both bases.', v_n;
  end if;
end $$;
