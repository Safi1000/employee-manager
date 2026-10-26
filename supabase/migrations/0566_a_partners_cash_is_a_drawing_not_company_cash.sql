-- 0566 — a partner's cash is a drawing, not company cash
--
-- DECIDED 2026-10-27 (Shayan): "the balances of partners shouldnt be here as
-- they are considered as drawings / negative in partnership ledgers".
--
-- Cash in Hand (0466) summed every custodian's held cash, partners included:
-- Shujaat Mehmood 1,312,000, Shafqat Ali Raza 58,699, Nauman Ahmed −17,100 —
-- 1,353,599 of the 1,523,629 shown. A partner's cash already stands against
-- him in partner_ledger (its custody lines), so counting it again as company
-- cash overstated what the company holds. From here Cash in Hand is the
-- office-staff custodians only (170,030 today). The Cash Holdings screen shows
-- office staff only; partners stay selectable wherever cash is recorded or
-- spent, and their balances are read on Partnership → Statements.
--
-- NOTHING POSTS. The ledger is not reclassified: partner_ledger already reads
-- these movements, and moving them to capital as well would count them twice
-- there. Only the company figure changes.
--
-- cash_in_hand has one author (0466): restated, behind a digest precondition —
-- an unrecognised body means an edit nobody recorded, and is refused.
--
-- DEFERRED: whether the GL should also carry partner custody outside 1000 Cash
-- in Hand (a reclass to each partner's account). If yes, the change is a
-- per-partner reclass entry plus excluding those accounts from the cash checks;
-- partner_ledger would then read them once, from capital, not custody.

-- Before: Cash in Hand as 0466 counts it, and the partners' part of it.
create temp table t0566 on commit drop as
select (select cash_balance from public.cash_in_hand('7f7899a0-edd2-4491-a40d-f81b54c68d1e')) as before_total,
       (select coalesce(sum(o.operational), 0) from public.custodian_held_operational('7f7899a0-edd2-4491-a40d-f81b54c68d1e') o
          join public.cash_locations cl on cl.id = o.cash_location_id
         where cl.custodian_partner_id is not null and cl.is_active is not false)
     - (select coalesce(sum(d.amount), 0) from public.cash_deposits d
          join public.cash_locations cl on cl.id = d.cash_location_id
         where cl.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and cl.custodian_partner_id is not null and cl.is_active is not false)
       as partners,
       position('0566' in pg_get_functiondef('public.cash_in_hand(uuid)'::regprocedure)) > 0 as replay;

do $guard$
begin
  if md5(pg_get_functiondef('public.cash_in_hand(uuid)'::regprocedure)) not in
     ('2e2b32e6e59f74aedc1e3dc642e905a0')
     and position('0566' in pg_get_functiondef('public.cash_in_hand(uuid)'::regprocedure)) = 0 then
    raise exception '0566 REFUSED: cash_in_hand is not the body 0466 wrote; someone else has edited it.';
  end if;
end $guard$;

create or replace function public.cash_in_hand(p_company_id uuid)
 returns table(cash_balance numeric, opening_balance numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed, 0466]: p_company_id IS the caller's tenant claim
  if p_company_id is null then
    return query select 0::numeric, 0::numeric;
    return;
  end if;
  perform public.assert_same_company(p_company_id);

  return query
  with cust as (
    -- 0566: office-staff custodians only. A partner's cash is a drawing in his
    -- partnership ledger, not company cash.
    select cl.id, cl.opening_balance
      from public.cash_locations cl
     where cl.company_id = p_company_id
       and cl.is_active is not false
       and cl.custodian_employee_id is not null
  )
  select round(
           coalesce((select sum(o.operational)
                       from public.custodian_held_operational(p_company_id) o
                      where o.cash_location_id in (select id from cust)), 0)
         - coalesce((select sum(d.amount)
                       from public.cash_deposits d
                      where d.cash_location_id in (select id from cust)), 0),
         2),
         round(coalesce((select sum(c.opening_balance) from cust c), 0), 2);
end
$function$;
comment on function public.cash_in_hand(uuid) is
  'DECIDED (0466, 2026-09-21; 0566, 2026-10-27): Cash in Hand = sum of every active OFFICE-STAFF custodian''s held cash (custodian_held_operational minus cash deposits to a bank); its opening = sum of those custodians'' opening_balance. A partner''s cash is a drawing in his partnership ledger and is not counted.';

do $$
declare v numeric; t record;
begin
  select * into t from t0566;
  if t.replay then return; end if;
  select cash_balance into v from public.cash_in_hand('7f7899a0-edd2-4491-a40d-f81b54c68d1e');
  -- What can break: a partner still counted, or an office custodian dropped.
  if round(v, 2) <> round(t.before_total - t.partners, 2) then
    raise exception '0566 REFUSED: Cash in Hand is %, not % less the partners'' %.', v, t.before_total, t.partners;
  end if;
  if exists (select 1 from public.cash_locations cl where cl.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
              and cl.custodian_partner_id is not null and cl.custodian_employee_id is not null) then
    raise exception '0566 REFUSED: a cash location names both a partner and an employee.';
  end if;
end $$;
