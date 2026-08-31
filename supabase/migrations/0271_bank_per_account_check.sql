-- 0271 — The bank-side twin of custodian_held_operational(): per named bank
-- account, the GL against the operational balance, with unpresented cheques as
-- a NAMED reconciling item rather than an unexplained gap.
--
-- WHY THE EXISTING BANK CHECKS CANNOT SEE THIS
--
--   bank_control_equals_bank_accounts     compares the bank SUBTREE to
--                                         sum(bank_accounts.balance)
--   bank_accounts_equal_transaction_deltas compares operational balance
--                                         movement to the operational
--                                         transaction log
--
-- The first cannot see misrouting between the control and its children, because
-- parent and child are both inside the subtree and the error cancels. The second
-- never touches the GL at all. So the following was true and invisible: EVERY
-- bank sub-account in the sandbox held exactly its opening balance and nothing
-- else — every bank posting since had landed on the undifferentiated control.
-- That is the identical defect G2 closed on the cash side, surviving on the bank
-- side because no check asked the question. ASK WHAT A CHECK MEASURES, NOT
-- WHETHER IT PASSES.
--
-- THE RECONCILIATION, AND WHY IT IS NOT operational = gl
--
-- cheque_apply_balance reduces bank_accounts.balance when a cheque is WRITTEN
-- (on INSERT). 0269 posts the GL when it CLEARS. Between those moments the two
-- differ by the outstanding amount, and that is correct in both — it is the
-- classic bank reconciliation item, the line every bank statement carries as
-- "less: cheques not yet presented".
--
--   operational = gl - outstanding_unpresented
--   difference  = gl - outstanding_unpresented - operational
--
-- Writing the reconciling item into the check by NAME is the whole point. The
-- alternative — widening a tolerance until the gap fits inside it — is a check
-- amended to fit an answer (§9.6).
--
-- EXPECTED RED ON ARRIVAL, and shipped anyway, for the reason 0259 established:
-- a check written after the data it must judge is a check written to agree with
-- it. Roughly 938,467 is currently unexplained across the bank accounts; the
-- decomposition is in docs/LEDGER_G3_CHEQUE_CAUSE.md and its three components
-- are an 800,000 balance edited behind the transaction log, 88,467 of payroll
-- paid above net salary, and this migration's own reconciling item.
--
-- BANK-type cash_locations only. A bank account with no sub-account is reported
-- by the notice below rather than silently scored as zero.

create or replace function public.bank_held_operational(p_company_id uuid)
returns table(bank_account_id uuid, account_name text,
              operational numeric, outstanding_cheques numeric,
              gl numeric, difference numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with acct as (
    select ba.id, ba.bank_name as nm, ba.balance, cl.coa_account_id
      from public.bank_accounts ba
      join public.cash_locations cl
        on cl.company_id = ba.company_id and cl.bank_account_id = ba.id
       and cl.coa_account_id is not null
     where ba.company_id = p_company_id
  )
  select a.id, a.nm,
         round(a.balance, 2),
         round(coalesce((select sum(c.amount) from public.cheques c
                          where c.company_id = p_company_id
                            and c.bank_account_id = a.id
                            and c.direction = 'outgoing'
                            and c.status = 'pending'), 0), 2),
         round(coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl
                          where jl.account_id = a.coa_account_id), 0), 2),
         round(coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl
                          where jl.account_id = a.coa_account_id), 0)
             - coalesce((select sum(c.amount) from public.cheques c
                          where c.company_id = p_company_id
                            and c.bank_account_id = a.id
                            and c.direction = 'outgoing'
                            and c.status = 'pending'), 0)
             - a.balance, 2)
    from acct a
   order by a.nm;
$function$;

comment on function public.bank_held_operational(uuid) is
  'Per named bank account: the GL balance on its sub-account, the operational bank_accounts.balance, and outstanding unpresented cheques as an explicit reconciling item. difference = gl - outstanding - operational. The bank-side twin of custodian_held_operational().';

do $$
declare v_n int;
begin
  select count(*) into v_n
    from public.bank_accounts ba
   where not exists (select 1 from public.cash_locations cl
                      where cl.company_id = ba.company_id and cl.bank_account_id = ba.id
                        and cl.coa_account_id is not null);
  if v_n > 0 then
    raise notice '0271: % bank account(s) have no GL sub-account and are outside this check', v_n;
  end if;
end $$;

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
  )
  select * from real_checks
  union all
  -- 15 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         15::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 15,
         (select count(*) from real_checks) = 15;
$function$;

do $$
declare v_n int; v_ok boolean; v_co uuid;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_n from public.ledger_checks(v_co);
  if v_n <> 16 then
    raise exception '0271: ledger_checks returns % rows, 16 expected (15 checks + canary)', v_n;
  end if;
  select passed into v_ok from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if not coalesce(v_ok, false) then
    raise exception '0271: checks_evaluated is red after the bump';
  end if;
end $$;