-- 0466 — Cash in Hand IS the sum of the custodians (user, 2026-09-21).
--
-- DECIDED, by the user: "whatever is the sum, current cash in hand should be
-- equal to that", and "Cash in Hand's opening balance should be equal to sum of
-- opening balance of all custodians".
--
-- Until now Cash in Hand was treasury.cash_balance, a stored scalar moved by
-- apply_money_delta and its siblings, and its opening was the one `opening`
-- bank_transactions row (PKR 0 on GGS, the 2026-09-03 stub). The custodians were
-- a breakdown that was supposed to reconcile up to it, and did not: on GGS the
-- treasury read PKR 60,874 while the custodians summed to PKR -24,964, and the
-- custodian openings sum to PKR -274,317 against a cash opening of 0.
--
-- cash_in_hand() returns both figures from the custodians:
--   cash_balance    = Σ custodian_held_operational() (opening + transfers +
--                     receipts - expenses - advances + cleared cash cheques +
--                     bank withdrawals + payroll + partner cash) minus cash
--                     deposits into a bank (0411), which that function does not
--                     count — the same terms custodian.ts / Cash Custody use.
--   opening_balance = Σ cash_locations.opening_balance over the same custodians.
-- Every screen that showed treasury.cash_balance reads this instead; Accounting's
-- "Set Opening" is gone, because the opening is now set per custodian.
--
-- NOT CHANGED, deliberately: treasury.cash_balance and the `opening` row are left
-- as they are and still moved by the money RPCs. No screen shows them as Cash in
-- Hand any more. 0456's -189,769 cash_adjustment is a treasury movement and so no
-- longer reaches the displayed figure either; the custodians carry the deficit
-- (Shayan Ahmed's -275,207 opening). 0456's DEFERRED on "what GGS's opening cash
-- actually was" is answered by this file: the sum of the custodian openings.
--
-- Scoped like custodian_held_operational: the company is asserted to be the
-- caller's; a null company yields zeros.
create or replace function public.cash_in_hand(p_company_id uuid)
returns table(cash_balance numeric, opening_balance numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- tenant guard [claimed, 0466]: p_company_id IS the caller's tenant claim
  if p_company_id is null then
    return query select 0::numeric, 0::numeric;
    return;
  end if;
  perform public.assert_same_company(p_company_id);

  return query
  with cust as (
    select cl.id, cl.opening_balance
      from public.cash_locations cl
     where cl.company_id = p_company_id
       and cl.is_active is not false
       and (cl.custodian_employee_id is not null or cl.custodian_partner_id is not null)
  )
  select round(
           coalesce((select sum(o.operational)
                       from public.custodian_held_operational(p_company_id) o), 0)
         - coalesce((select sum(d.amount)
                       from public.cash_deposits d
                      where d.cash_location_id in (select id from cust)), 0),
         2),
         round(coalesce((select sum(c.opening_balance) from cust c), 0), 2);
end
$$;

revoke all on function public.cash_in_hand(uuid) from public, anon;
grant execute on function public.cash_in_hand(uuid) to authenticated, service_role;

comment on function public.cash_in_hand(uuid) is
  'DECIDED (0466, user 2026-09-21): Cash in Hand = sum of every active custodian''s held cash '
  '(custodian_held_operational minus cash deposits to a bank); its opening = sum of those '
  'custodians'' opening_balance. Screens read this, not treasury.cash_balance.';

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
