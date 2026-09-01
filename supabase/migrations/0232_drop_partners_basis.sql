-- 0232 — Repoint every reader of partners.basis at company policy, then drop it.
--
-- NOT APPLIED. Depends on 0230 (which adds and backfills
-- finance_settings.partner_remuneration_basis) and on Shayan's sign-off, since
-- it changes how partner remuneration is measured.
--
-- APPLY ON OR BEFORE 2026-09-30 — before the next partner statement is drawn.
-- While 0230 is applied and this is not, partners.basis is redundant but not
-- stale (0230's assert guarantees it agrees with the company setting), so the
-- window is safe. It is not safe indefinitely: the moment someone edits a
-- partner's basis through the UI, the two disagree and there is nothing to say
-- which won. If this has not applied by 2026-09-30, either apply it or move
-- this date deliberately, the same way 0231 handles the backup retention date.
--
-- Section 5.1 of docs/LEDGER_PHASE1_F41_DEFECT_RECORD.md, and the section 5.2
-- guard clause, land together here — they are the same change. Defect 1 was
-- that partner_take branched on partners.basis (per PARTNER) while pl.profit
-- branched on p_basis (per REPORT), so the two halves of one number could be
-- measured differently by construction. Making basis company-wide removes one
-- half of the mismatch; the guard removes the other by refusing a report drawn
-- on a basis the company does not use.
--
-- FRONTEND DEPENDENCY — this migration must ship WITH a UI change, not before it:
--   PartnerFormModal.tsx:68,95,186,275-282,340  writes and edits partners.basis
--                                               (a per-partner dropdown)
--   PartnerDetailModal.tsx:18,210-212,226,255   reads it for labels
--   supabase.ts:1835                            declares it on the Partner type
-- The dropdown is the exact mechanism by which two partners can come to disagree
-- about what a rupee of profit is. It should become a read-only display of the
-- company setting, editable in one place, or disappear entirely. Applying this
-- migration against the current UI makes the partner form fail on save.
--
-- What this does NOT fix: defects 2 and 3 (regional_pl_range keying revenue on
-- invoice_date, and per_client's row set being driven by cs_rev so a cash-basis
-- partner loses any client that PAID but was not INVOICED in the period). Those
-- are the F4 replacement work. This migration is deliberately narrower.

-- ---------------------------------------------------------------------------
-- 1. The single source of basis, and the tripwire.
-- ---------------------------------------------------------------------------
-- plpgsql, not sql, because it has to be able to RAISE. Called once per report.

create or replace function public.partner_basis_for_report(p_basis text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_policy text;
begin
  select fs.partner_remuneration_basis into v_policy
    from public.finance_settings fs
   where fs.company_id = public.current_company_id();

  if v_policy is null then
    raise exception 'No partner remuneration basis configured for this company — apply migration 0230'
      using errcode = '23502';
  end if;

  -- The tripwire. A report drawn on one basis while partners are remunerated on
  -- another is the defect-1 shape; refuse it loudly rather than return a number
  -- whose two halves were measured differently.
  if p_basis is not null and lower(p_basis) <> v_policy then
    raise exception
      'Report basis "%" disagrees with this company''s partner remuneration basis "%" — one of the two is wrong, and a figure mixing them is meaningless',
      p_basis, v_policy
      using errcode = '22023',
            hint = 'Draw the report on the company basis, or change the company basis deliberately in finance_settings.';
  end if;

  return v_policy;
end;
$function$;

comment on function public.partner_basis_for_report(text) is
  'Returns the company partner remuneration basis, raising if the caller asked for a different one. The single reader of finance_settings.partner_remuneration_basis, and the guard against defect 1 (basis mixed by construction).';

-- ---------------------------------------------------------------------------
-- 2. Prove the fallback branch we are about to remove is dead.
-- ---------------------------------------------------------------------------
-- partner_take had a branch for `rp.basis is null or not in ('cash','revenue')`
-- that paid `region profit x pct` instead of the per-client sum. With basis
-- hoisted to a NOT NULL, CHECK-constrained company column that branch cannot
-- fire — but only if it is dead TODAY too, otherwise this migration silently
-- changes what a real partner is paid.
-- Skipped when the column is already gone: production applied 0232 through the
-- SQL editor, which records no schema_migrations row, so a runner will replay
-- this against a database where partners.basis no longer exists. The assert is
-- moot there — the branch it protects was removed with the column — but an
-- unguarded reference to a dropped column aborts the migration long before the
-- IF EXISTS drop at the foot of this file is ever reached.
do $$
declare v_n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'partners'
                    and column_name = 'basis') then
    raise notice '0232: partners.basis already dropped — fallback assert skipped';
    return;
  end if;

  execute $q$
    select count(*) from public.partners p
     where p.scope = 'BRANCH' and p.is_active
       and (p.basis is null or lower(p.basis) not in ('cash', 'revenue'))
  $q$ into v_n;

  if v_n > 0 then
    raise exception
      '% active regional partner(s) have no usable basis and are currently paid by the region-profit fallback — removing that branch would change their pay. Resolve first.',
      v_n using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. partnership_allocation — basis from policy, guard applied, fallback gone.
-- ---------------------------------------------------------------------------
-- p_basis keeps its 'revenue' default for signature compatibility (dropping a
-- default is an error on CREATE OR REPLACE), but it is now VALIDATED rather
-- than obeyed: a caller passing the wrong one gets an exception, not a number.

create or replace function public.partnership_allocation(p_start date, p_end date, p_basis text default 'revenue'::text)
returns table(row_kind text, branch_id uuid, region_name text, partner_id uuid,
              partner_name text, share_pct numeric, own_profit numeric,
              ho_allocated numeric, base_amount numeric, amount numeric, residual numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  cfg as (select public.partner_basis_for_report(p_basis) as basis),
  raw as (
    select r.branch_id,
           r.region_name,
           coalesce(b.is_head_office, false) as is_ho,
           case when cfg.basis = 'cash' then r.profit_cash  else r.profit_accrual  end as profit,
           case when cfg.basis = 'cash' then r.revenue_cash else r.revenue_accrual end as revenue
      from public.regional_pl_range(p_start, p_end) r
      left join public.branches b on b.id = r.branch_id
      cross join cfg
  ),
  ho as (
    select coalesce(sum(profit) filter (where is_ho), 0) as ho_profit,
           coalesce(sum(greatest(revenue, 0)) filter (where not is_ho), 0) as rev_base
      from raw
  ),
  adj as (
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
           case
             when ho.rev_base <= 0 then 0
             when raw.is_ho then -raw.profit
             else ho.ho_profit * greatest(raw.revenue, 0) / ho.rev_base
           end as ho_allocated
      from raw cross join ho
  ),
  pl as (
    select branch_id, region_name, is_ho, own_profit, ho_allocated,
           own_profit + ho_allocated as profit
      from adj
  ),
  reg_p as (
    select p.id, p.name, p.branch_id, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'BRANCH'
       and p.is_active and p.branch_id is not null
       and (p.start_month is null or p.start_month <= p_end)
  ),
  eq_p as (
    select p.id, p.name, p.profit_share_percent
      from public.partners p cross join cid
     where p.company_id = cid.company_id and p.scope = 'COMPANY' and p.is_active
       and (p.start_month is null or p.start_month <= p_end)
  ),
  cs_cash as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'cash')),
  cs_rev  as (select client_id, branch_id, net from public.client_statement_loaded(p_start, p_end, 'revenue')),
  per_client as (
    select rp.id as partner_id, rp.branch_id,
           coalesce(o.share_percent, rp.profit_share_percent) as pct,
           -- Company basis, not partner basis. This is the defect-1 fix.
           case cfg.basis
             when 'cash'    then coalesce(csc.net, 0)
             when 'revenue' then coalesce(csr.net, 0)
           end as client_net
      from reg_p rp
      cross join cfg
      left join cs_rev  csr on csr.branch_id = rp.branch_id
      left join cs_cash csc on csc.branch_id = rp.branch_id
                           and csc.client_id = csr.client_id
      left join lateral (
        select s.share_percent
          from public.partner_client_shares s
         where s.partner_id = rp.id and s.client_id = csr.client_id
           and s.effective_month <= p_start
         order by s.effective_month desc
         limit 1
      ) o on true
  ),
  partner_take as (
    -- The `basis is null` fallback that paid `region profit x pct` is gone:
    -- section 2 above proves no active regional partner reaches it, and with
    -- basis hoisted to a NOT NULL CHECK-constrained column nothing can.
    select rp.id as partner_id, rp.branch_id,
           round(coalesce((select sum(pc.client_net * pc.pct / 100)
                             from per_client pc
                            where pc.partner_id = rp.id), 0), 2) as amount
      from reg_p rp join pl on pl.branch_id = rp.branch_id
  ),
  reg_alloc as (
    select pl.branch_id, pl.region_name, pl.own_profit, pl.ho_allocated, pl.profit,
           coalesce((select sum(pt.amount) from partner_take pt where pt.branch_id = pl.branch_id), 0) as taken
      from pl
  ),
  pool as (select coalesce(sum(profit - taken), 0) as residual from reg_alloc)
  select 'REGION'::text, ra.branch_id, ra.region_name,
         null::uuid, null::text, null::numeric,
         ra.own_profit, ra.ho_allocated, ra.profit, ra.taken, ra.profit - ra.taken
    from reg_alloc ra
  union all
  select 'REGIONAL_PARTNER'::text, pl.branch_id, pl.region_name,
         reg_p.id, reg_p.name, reg_p.profit_share_percent,
         pl.own_profit, pl.ho_allocated, pl.profit,
         pt.amount, null::numeric
    from reg_p
    join pl on pl.branch_id = reg_p.branch_id
    join partner_take pt on pt.partner_id = reg_p.id
  union all
  select 'EQUITY_PARTNER'::text, null::uuid, null::text,
         eq_p.id, eq_p.name, eq_p.profit_share_percent,
         null::numeric, null::numeric, pool.residual,
         round(pool.residual * eq_p.profit_share_percent / 100, 2), null::numeric
    from eq_p cross join pool
  union all
  select 'UNALLOCATED_HO'::text, null::uuid, null::text, null::uuid, null::text,
         null::numeric, null::numeric, null::numeric,
         ho.ho_profit, ho.ho_profit, null::numeric
    from ho where ho.rev_base <= 0 and ho.ho_profit <> 0
  union all
  select 'UNALLOCATED'::text, null::uuid, null::text, null::uuid, null::text,
         100 - coalesce((select sum(profit_share_percent) from eq_p), 0),
         null::numeric, null::numeric, pool.residual,
         pool.residual - coalesce((select sum(round(pool.residual * profit_share_percent / 100, 2)) from eq_p), 0),
         null::numeric
    from pool;
$function$;

-- ---------------------------------------------------------------------------
-- 4. partner_client_breakdown — and a defect it was hiding.
-- ---------------------------------------------------------------------------
-- It read `coalesce(basis, 'revenue')`. partnership_allocation's fallback was
-- region-profit. Locked policy A9 says CASH. Three different answers to "what
-- happens when basis is absent", in two functions that are supposed to agree —
-- the drawer and the summary could disagree for the same partner and period.
-- One company setting removes the question rather than picking a winner.

create or replace function public.partner_client_breakdown(p_partner_id uuid, p_start date, p_end date)
returns table(client_id uuid, client_name text, client_code text, basis text,
              client_net numeric, share_percent numeric, is_override boolean, amount numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cfg as (select public.partner_basis_for_report(null) as basis),
  p as (
    select id, branch_id, profit_share_percent, scope
      from public.partners
     where id = p_partner_id
  ),
  cs as (
    select s.client_id, s.client_name, s.client_code, s.branch_id, s.net
      from p, cfg, lateral public.client_statement_loaded(p_start, p_end, cfg.basis) s
     where p.scope = 'BRANCH' and s.branch_id = p.branch_id
  )
  select cs.client_id, cs.client_name, cs.client_code,
         cfg.basis,
         cs.net,
         coalesce(o.share_percent, p.profit_share_percent) as share_percent,
         (o.share_percent is not null) as is_override,
         round(cs.net * coalesce(o.share_percent, p.profit_share_percent) / 100, 2) as amount
    from cs
    cross join p
    cross join cfg
    left join lateral (
      select s.share_percent
        from public.partner_client_shares s
       where s.partner_id = p.id and s.client_id = cs.client_id
         and s.effective_month <= p_start
       order by s.effective_month desc
       limit 1
    ) o on true
   order by cs.client_name;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Drop last, so any failure above leaves the column readable.
-- ---------------------------------------------------------------------------
-- IF EXISTS so the migration is replayable. Production applied 0232 through
-- the SQL editor, which records no schema_migrations row, so a runner will
-- legitimately try this again against a database where the column is already
-- gone. Without the guard that attempt aborts here and blocks everything after.
alter table public.partners drop column if exists basis;
