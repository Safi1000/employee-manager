-- 0352 — ho_apportionment_driver gets the tenant guard it should have shipped
--        with, which is the SECOND time this has happened in one sitting.
--
-- 0348 closed two tenant guard gaps left by 0345 and 0347 and its header said
-- an argued exemption stops being true when the next caller appears. 0349 then
-- created ho_apportionment_driver with no guard at all, and
-- tenant_guard_covers_every_parameter went from 0 to 2 again.
--
-- Worth stating plainly rather than quietly fixing: the check caught it both
-- times within minutes, and both times it was the same author making the same
-- omission immediately after writing about it. The lesson is not "remember the
-- guard" — it is that a new SECURITY DEFINER function taking a company id is
-- the case the check exists for, and the check is the thing that works.
--
-- THE EXPOSURE, stated honestly. A plain `create function` grants EXECUTE to
-- PUBLIC. ho_apportionment_driver takes a company id and a branch id and
-- returns that branch's invoiced revenue, so between 0349 and this migration
-- any signed-in user could read any company's monthly billing by branch. It is
-- one number per call rather than a schedule, which makes it narrower than
-- 0347's leak, not different in kind.
--
-- Both parameters are guarded, and they take different shapes:
--   p_company_id  [claimed]  — the caller hands it over, so it is checked
--   p_branch_id   [resolved] — the owning company is looked up from the branch,
--                              which also stops a branch of another company
--                              being read through a company id the caller does
--                              legitimately hold.

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

  -- tenant guard [resolved]: owning company looked up from p_branch_id via
  -- public.branches. Without this, a caller holding a legitimate claim to one
  -- company could pass another company's branch id and read its revenue.
  if p_branch_id is not null then
    perform public.assert_same_company(
      (select company_id from public.branches where id = p_branch_id));
  end if;

  -- Deliberately NO basis parameter. 0349: cost apportionment follows service
  -- delivered, so this is invoiced revenue at SERVICE month (A4) whichever
  -- basis the report is run on. If you are about to add a basis argument here,
  -- read 0349's header first — its absence is the policy.
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

comment on function public.ho_apportionment_driver(uuid, uuid, date) is
  '0349/0352: the head-office apportionment driver — invoiced revenue at service month, on BOTH bases. Replaces the basis-following driver of 0225. Head office cost is driven by business done, not by whether the client paid on time. A10 (never guard-days) is unchanged. Tenant-guarded on both uuid parameters since 0352; 0349 shipped it with neither and with the default PUBLIC execute grant.';

revoke execute on function public.ho_apportionment_driver(uuid, uuid, date) from public, anon;
grant execute on function public.ho_apportionment_driver(uuid, uuid, date) to authenticated;

-- The blocker from 0351 is called by run_profit_allocation, which is called by
-- a screen; it is already guarded. This is only about 0349's function.
do $$
declare v_gaps int;
begin
  select count(*) into v_gaps from public.tenant_guard_gaps();
  if v_gaps <> 0 then
    raise exception '0352 FAILED: % tenant guard gap(s) remain.', v_gaps;
  end if;
  raise notice '0352: 0 tenant guard gaps.';
end $$;
