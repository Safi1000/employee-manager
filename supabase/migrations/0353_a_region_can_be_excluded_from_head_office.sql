-- 0353 — a region not managed by head office can be excluded from absorbing it.
--
-- THE RULE. A region flagged as excluded absorbs no head office cost. The pool
-- then spreads across the REMAINING regions by invoiced revenue (0349), so the
-- pool is still fully allocated — it is redistributed, never reduced.
--
-- THIS CHANGES WHAT A PARTNER TAKES HOME, so the brief required three things
-- and all three are here:
--
--   1. THE REASON is stored with the flag, and is NOT NULLABLE when the flag is
--      set. A constraint, not a convention: an exclusion with no recorded reason
--      is indistinguishable from a mistake six months later, and the person it
--      costs money will ask.
--   2. A PREVIEW before it applies — ho_exclusion_preview() answers "what does
--      each region absorb now, and what would it absorb after", for a proposed
--      set of exclusions, without writing anything.
--   3. A CHECK that the pool still fully allocates, so an exclusion cannot
--      leave head office cost stranded.
--
-- THE DEGENERATE CASE, AND WHY IT REFUSES RATHER THAN REDISTRIBUTES.
-- If every revenue-earning region is excluded, the denominator is zero and the
-- pool has nowhere to go. That is not a redistribution, it is the whole pool
-- vanishing into `unallocated` — the exact defect 0225 was written to end. So
-- the guard below refuses the WRITE that would create that state, rather than
-- letting the allocation discover it later. Refusing at the point of the flag
-- means the person who caused it is the person who sees the error.

alter table public.branches
  add column if not exists ho_excluded        boolean not null default false,
  add column if not exists ho_excluded_reason text,
  add column if not exists ho_excluded_at     timestamptz,
  add column if not exists ho_excluded_by     uuid references public.profiles(id);

comment on column public.branches.ho_excluded is
  '0353: this region does not absorb head office cost. The pool redistributes across the remaining regions by invoiced revenue — it is never reduced. Changes what regional partners take home, so a reason is required.';
comment on column public.branches.ho_excluded_reason is
  '0353: WHY this region is excluded. Required whenever ho_excluded is true, by constraint rather than convention — an exclusion with no reason cannot be told from a mistake later, and it costs somebody money.';

alter table public.branches drop constraint if exists branches_ho_exclusion_has_a_reason;
alter table public.branches add constraint branches_ho_exclusion_has_a_reason check (
  ho_excluded = false
  or (ho_excluded_reason is not null and length(btrim(ho_excluded_reason)) >= 10)
);

-- Head office cannot be excluded from itself: it is the giver of the pool, and
-- 0225 already makes it a receiver too when it bills direct. Flagging it would
-- be a statement about the wrong side of the transaction.
alter table public.branches drop constraint if exists branches_head_office_not_excludable;
alter table public.branches add constraint branches_head_office_not_excludable check (
  not (is_head_office and ho_excluded)
);

-- ---------------------------------------------------------------------------
-- The driver honours the flag. Surgery on 0352's body — one added clause.
-- ---------------------------------------------------------------------------
create or replace function public.ho_apportionment_driver(
  p_company_id uuid, p_branch_id uuid, p_period date)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare v_amt numeric;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company(
      (select company_id from public.branches where id = p_branch_id));
  end if;

  -- 0353. An excluded region contributes ZERO to the driver, which removes it
  -- from both the numerator and the denominator in one step: it absorbs nothing
  -- and the remaining regions' weights rise to fill the gap. The pool is not
  -- reduced, only redistributed.
  if exists (select 1 from public.branches
              where id = p_branch_id and ho_excluded) then
    return 0;
  end if;

  -- Deliberately NO basis parameter. 0349: cost apportionment follows service
  -- delivered, so this is invoiced revenue at SERVICE month (A4) whichever
  -- basis the report is run on.
  select coalesce(sum(il.amount), 0) into v_amt
    from public.invoice_lines il
    join public.invoices i on i.id = il.invoice_id
   where i.company_id = p_company_id
     and i.branch_id = p_branch_id
     and coalesce(i.period_start, i.invoice_date) >= date_trunc('month', p_period)::date
     and coalesce(i.period_start, i.invoice_date) <  (date_trunc('month', p_period) + interval '1 month')::date;

  return v_amt;
end;
$fn$;

revoke execute on function public.ho_apportionment_driver(uuid, uuid, date) from public, anon;
grant execute on function public.ho_apportionment_driver(uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- The preview. Nothing is written; a proposed exclusion set is passed in.
-- ---------------------------------------------------------------------------
create or replace function public.ho_exclusion_preview(
  p_company_id uuid, p_period date, p_excluded uuid[] default null)
returns table (
  branch_id      uuid,
  region_name    text,
  invoiced       numeric,
  excluded_now   boolean,
  excluded_after boolean,
  absorbs_now    numeric,
  absorbs_after  numeric,
  delta          numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_pool  numeric;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_pool := coalesce(public.ho_overhead_for_month(p_company_id, v_month), 0);

  return query
  with b as (
    select br.id, br.name::text as nm, br.ho_excluded,
           coalesce(br.id = any(coalesce(p_excluded, array[]::uuid[])), false) as prop,
           -- Raw invoiced revenue, ignoring BOTH the current flag and the
           -- proposed one, so each scenario can apply its own.
           coalesce((
             select sum(il.amount) from public.invoice_lines il
               join public.invoices i on i.id = il.invoice_id
              where i.company_id = p_company_id and i.branch_id = br.id
                and coalesce(i.period_start, i.invoice_date) >= v_month
                and coalesce(i.period_start, i.invoice_date) < (v_month + interval '1 month')::date
           ), 0) as inv
      from public.branches br
     where br.company_id = p_company_id and br.active and not br.is_head_office
  ),
  w as (
    select b.*,
           case when b.ho_excluded then 0 else b.inv end as w_now,
           case when b.prop        then 0 else b.inv end as w_aft
      from b
  ),
  t as (select coalesce(sum(w_now), 0) tn, coalesce(sum(w_aft), 0) ta from w)
  select w.id, w.nm, w.inv, w.ho_excluded, w.prop,
         round(case when t.tn > 0 then v_pool * w.w_now / t.tn else 0 end, 2),
         round(case when t.ta > 0 then v_pool * w.w_aft / t.ta else 0 end, 2),
         round(case when t.ta > 0 then v_pool * w.w_aft / t.ta else 0 end
             - case when t.tn > 0 then v_pool * w.w_now / t.tn else 0 end, 2)
    from w cross join t
   order by w.nm;
end;
$fn$;

comment on function public.ho_exclusion_preview(uuid, date, uuid[]) is
  '0353: what each region absorbs of the head office pool now, and what it would absorb if p_excluded were the excluded set. Writes nothing. Pass the proposed exclusions, not the current ones — passing NULL previews "nothing excluded", which is how you see what an existing exclusion is costing the others.';

revoke execute on function public.ho_exclusion_preview(uuid, date, uuid[]) from public, anon;
grant execute on function public.ho_exclusion_preview(uuid, date, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The guard: an exclusion may not strand the pool.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_ho_exclusion_leaves_a_base()
returns trigger
language plpgsql
as $fn$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_base  numeric;
  v_pool  numeric;
begin
  if new.ho_excluded is not true or old.ho_excluded is true then
    return new;                       -- clearing or unchanged: always allowed
  end if;

  v_pool := coalesce(public.ho_overhead_for_month(new.company_id, v_month), 0);
  if v_pool = 0 then return new; end if;   -- nothing to strand

  -- What would still be able to absorb, counting this row as excluded.
  select coalesce(sum(
           coalesce((select sum(il.amount) from public.invoice_lines il
                       join public.invoices i on i.id = il.invoice_id
                      where i.company_id = br.company_id and i.branch_id = br.id
                        and coalesce(i.period_start, i.invoice_date) >= v_month
                        and coalesce(i.period_start, i.invoice_date) < (v_month + interval '1 month')::date), 0)
         ), 0)
    into v_base
    from public.branches br
   where br.company_id = new.company_id and br.active and not br.is_head_office
     and br.id <> new.id and not br.ho_excluded;

  if coalesce(v_base, 0) <= 0 then
    raise exception
      'Excluding % would leave no region able to absorb head office cost this month, so the whole pool of % would be stranded rather than redistributed. Exclude it in a month where another region has invoiced revenue, or clear another region''s exclusion first.',
      new.name, v_pool
      using errcode = 'P0001';
  end if;

  return new;
end;
$fn$;

comment on function public.enforce_ho_exclusion_leaves_a_base() is
  '0353: refuses an exclusion that would leave the head office pool with no region to land on. Redistribution is the point; vanishing is the defect 0225 exists to prevent.';

drop trigger if exists trg_ho_exclusion_leaves_a_base on public.branches;
create trigger trg_ho_exclusion_leaves_a_base
  before update of ho_excluded on public.branches
  for each row execute function public.enforce_ho_exclusion_leaves_a_base();

-- ---------------------------------------------------------------------------
-- Probe.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co   uuid;
  v_n    int;
  v_msg  text;
begin
  select id into v_co from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_co is null then raise notice '0353: GGS absent; probe skipped.'; return; end if;

  begin
    -- A reason is required, and ten characters of it.
    begin
      update public.branches set ho_excluded = true, ho_excluded_reason = 'x'
       where company_id = v_co and not is_head_office
       and id = (select id from public.branches where company_id = v_co and not is_head_office order by name limit 1);
      raise exception '0353 FAILED: an exclusion was accepted with a one-character reason.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0353 FAILED%' then raise; end if;
    end;

    -- Head office cannot be excluded.
    begin
      update public.branches set ho_excluded = true,
             ho_excluded_reason = 'probe: head office should refuse this'
       where company_id = v_co and is_head_office;
      raise exception '0353 FAILED: head office accepted an exclusion flag.';
    exception when others then
      v_msg := sqlerrm;
      if v_msg like '0353 FAILED%' then raise; end if;
    end;

    -- The preview answers without writing.
    select count(*) into v_n from public.ho_exclusion_preview(v_co, current_date, null);
    raise notice '0353: preview returned % non-head-office region(s).', v_n;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0353: probe passed — reason required, head office refused, preview reads clean.';
  end;
end $$;
