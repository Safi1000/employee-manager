-- Cash Entitlement Ledger (spec section 8).
--
-- Physical bank accounts stay shared. On top, the system continuously computes
-- each region's ENTITLEMENT within the pool:
--
--   collections attributed to it
--   − payments made for it
--   − allocation transfers (HO cost allocation, §6)
--   ± inter-region loans (§7)
--
-- Σ(entitlements) always equals total cash, by construction, because every
-- cash-moving journal line is region-tagged (§1). This is a READ model over
-- the existing ledger — no new postings — so it can never drift from the cash
-- it partitions. Answers "of the cash in the pool, how much is Lahore's?"

-- The cash+bank movement attributable to a region, from the region-tagged
-- journal lines on cash/bank accounts (control + sub-ledgers). This already
-- folds in collections (debits), payments (credits), the HO allocation, and
-- the inter-region loan cash shifts, because all of them post region-tagged
-- lines that touch cash/bank.
create or replace function public.region_cash_entitlement(p_company_id uuid, p_branch_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(jl.debit - jl.credit), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and jl.branch_id = p_branch_id
     and (
       a.system_key in ('cash', 'bank', 'bonus_reserve')
       or a.parent_id in (select id from public.chart_of_accounts
                           where company_id = p_company_id and system_key in ('cash', 'bank'))
     );
$$;

-- Entitlement per region, with the inter-region net position shown alongside.
-- The reserve is broken out so a region can see restricted vs free cash.
create or replace view public.cash_entitlements
  with (security_invoker = true) as
  with cash_lines as (
    select je.company_id, jl.branch_id,
           sum(case when a.system_key = 'bonus_reserve' then jl.debit - jl.credit else 0 end) as reserve,
           sum(jl.debit - jl.credit) as total_cash_movement
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where a.system_key in ('cash','bank','bonus_reserve')
        or a.parent_id in (select id from public.chart_of_accounts
                            where system_key in ('cash','bank'))
     group by je.company_id, jl.branch_id
  )
  select cl.company_id,
         cl.branch_id,
         b.name as region_name,
         b.kind as region_kind,
         cl.total_cash_movement as entitlement,
         cl.reserve             as restricted_reserve,
         cl.total_cash_movement - cl.reserve as free_entitlement,
         public.interregion_net_position(cl.company_id, cl.branch_id) as interregion_net_position
    from cash_lines cl
    left join public.branches b on b.id = cl.branch_id;

-- Proof view: Σ(regional entitlements) vs the company's total cash. The
-- difference must always be zero — if it isn't, a cash line lost its region
-- tag, which is exactly the failure §1's tagging exists to prevent.
create or replace view public.cash_entitlement_reconciliation
  with (security_invoker = true) as
  with entitlements as (
    select company_id, sum(entitlement) as sum_entitlements
      from public.cash_entitlements group by company_id
  ),
  total_cash as (
    select je.company_id, sum(jl.debit - jl.credit) as pool_cash
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where a.system_key in ('cash','bank','bonus_reserve')
        or a.parent_id in (select id from public.chart_of_accounts
                            where system_key in ('cash','bank'))
     group by je.company_id
  )
  select e.company_id,
         e.sum_entitlements,
         t.pool_cash,
         e.sum_entitlements - t.pool_cash as difference
    from entitlements e join total_cash t on t.company_id = e.company_id;
