-- 0275 — No active cash location may hold less than nothing.
--
-- WHY THIS IS A CHECK AND NOT A NOTE
--
-- HAMNA at −3,477.00 and Safi at −1,999.87 were found by looking, not by
-- failing. A custodian holding a negative amount of cash is a physical
-- impossibility: the money is in someone's hand or it is not. Red therefore
-- means a real defect, and one of exactly two kinds —
--
--   * a missing opening balance: the custodian started with cash the system was
--     never told about, so every disbursement since has driven the running total
--     below zero;
--   * an unrecorded receipt: money reached the custodian by a path that writes
--     nothing.
--
-- Both are silent today. Neither is visible to
-- cash_per_location_gl_equals_operational, which compares the GL to the
-- operational figure and is perfectly GREEN for both of these locations — the
-- ledger and the operational record agree precisely that the custodian holds
-- less than nothing. Two records agreeing is not the same as either being right.
-- That is the third distinct thing to ask of a check: not only what it compares,
-- but whether agreement between the two things compared is evidence of anything.
--
-- OPERATIONAL side only. The GL side is already covered, and using the
-- operational figure means this stays true even if a posting rule is wrong.
--
-- EXPECTED RED ON ARRIVAL: 2 locations. Shipped anyway (0259's rule).

create or replace function public.negative_custodian_balances(p_company_id uuid)
returns table(cash_location_id uuid, location_name text, operational numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select h.cash_location_id, h.location_name, h.operational
    from public.custodian_held_operational(p_company_id) h
   where h.operational < -0.005
   order by h.operational;
$function$;

comment on function public.negative_custodian_balances(uuid) is
  'Active custodian cash locations holding a negative amount of cash — a physical impossibility. Red means a missing opening balance or an unrecorded receipt (0275).';

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with real_checks as (
    select b.check_name, b.expected, b.actual, b.difference, b.passed
      from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all
    select 'cash_per_location_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
    union all
    select 'every_source_row_posted'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unposted_source_rows(p_company_id)
    union all
    select 'bank_per_account_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.bank_held_operational(p_company_id) b
     where abs(b.difference) > 0.005
    union all
    select 'no_negative_custodian_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.negative_custodian_balances(p_company_id)
  )
  select * from real_checks
  union all
  -- 16 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         16::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 16,
         (select count(*) from real_checks) = 16;
$function$;

-- Prove it can fail AND can pass, on real data, rather than asserting either.
-- A check that is only ever seen red is as uninformative as one only ever seen
-- green: neither has been shown to discriminate.
do $$
declare v_co uuid; v_n int; v_total int; v_ok boolean;
begin
  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  if v_co is null then
    raise notice '0275: no sandbox company; discrimination not demonstrated here';
  else
    select count(*) into v_n from public.negative_custodian_balances(v_co);
    select count(*) into v_total from public.custodian_held_operational(v_co);
    raise notice '0275: % of % custodian locations are negative', v_n, v_total;
    if v_n = 0 then
      raise notice '0275: check is GREEN on the sandbox';
    elsif v_n = v_total then
      raise exception '0275: EVERY location is negative — the arithmetic is suspect, not the data';
    end if;
  end if;

  select count(*) into v_total from public.ledger_checks(
    (select id from public.companies order by created_at limit 1));
  if v_total <> 17 then
    raise exception '0275: ledger_checks returns % rows, 17 expected (16 checks + canary)', v_total;
  end if;
  select passed into v_ok from public.ledger_checks(
    (select id from public.companies order by created_at limit 1))
   where check_name = 'checks_evaluated';
  if not coalesce(v_ok, false) then
    raise exception '0275: checks_evaluated is red after the bump';
  end if;
end $$;