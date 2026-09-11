-- 0426: align Emaar DHA ISB's client-level EOBI fallback to the 400 its
-- contract already names. Nothing already disbursed is touched.
--
-- DECIDED (user, this request): "emaar is already disbursed 370 which was
-- correct back then but now its 400."
--
-- So 370 is not a mistake to be corrected — it is the right figure for the
-- months it was applied to, and 400 is the right figure from here. That makes
-- this a FORWARD change with no retrospective arm, which is the only reason it
-- can be a one-row write.
--
-- THE STATE BEING FIXED. Emaar's contract said eobi_amount = 400 while the
-- client fallback said 370, and which one a guard got depended on whether they
-- happened to carry `employees.contract_id`:
--
--     2 guards WITH a contract_id  -> contract arm  -> 400
--    68 guards with only a LINE    -> client arm    -> 370
--
-- One client, one month, two EOBI figures, decided by which code path last
-- touched each record. August's payslips show it exactly: 70 rows at 370 and
-- 2 at 400. 0427 closes the contract_id gap that caused the split; this file
-- settles WHICH figure both arms should agree on, because a backfill that
-- silently moved 68 people from 370 to 400 as a side effect of a data cleanup
-- would be a pay change nobody authorised.
--
-- WHY NO PAYSLIP IS REWRITTEN. EOBI is resolved when a payslip is generated or
-- saved, and stored on the payslip as it stood then. Changing the client row
-- therefore has no retrospective effect at all: the 66 disbursed August
-- payslips keep their 370, which is what was asked for. This is the useful
-- half of the derived-at-save design — history stays as it was paid.
--
-- SAY THIS OUT LOUD BECAUSE IT WILL BITE SOMEBODY: Emaar has FOUR undisbursed
-- August payslips still sitting at 370 (plus the 2 at 400). They are not
-- rewritten by this file, but anyone who RE-SAVES one on the Payroll screen
-- after today will see it pick up 400 — and that guard will then differ from
-- the 66 colleagues paid 370 for the same month. If August is meant to close
-- uniformly at 370, disburse those four BEFORE re-saving them. Not automated
-- here: which figure an open August payslip should carry is a decision about
-- that month, not something a migration should assume.

do $$
declare
  v_client       uuid;
  v_name         text;
  v_was          numeric;
  v_contract_amt numeric;
  v_n            int;
begin
  select c.id, c.name, coalesce(c.eobi_amount, 0)
    into v_client, v_name, v_was
  from public.clients c
  where c.client_code = 'CLI-0001';

  if v_client is null then
    raise exception '0426: no client with code CLI-0001';
  end if;
  if v_name not ilike '%Emaar%' then
    raise exception '0426: CLI-0001 is "%", which is not Emaar — refusing', v_name;
  end if;

  -- Take the figure from the contract rather than restating 400, so this file
  -- cannot disagree with the document it is propagating.
  select k.eobi_amount into v_contract_amt
  from public.contracts k
  where k.client_id = v_client
    and k.status = 'active'
    and k.eobi_deduction
    and k.eobi_amount is not null
  order by k.start_date desc
  limit 1;

  if v_contract_amt is null then
    raise exception '0426: no active Emaar contract names an EOBI amount';
  end if;
  if v_contract_amt <> 400 then
    raise exception
      '0426: the Emaar contract names EOBI %, not the 400 this change was told to apply', v_contract_amt;
  end if;

  if v_was = v_contract_amt then
    raise notice '0426: Emaar already resolves to % at the client — nothing to do', v_contract_amt;
  else
    update public.clients
       set eobi_enabled = true,
           eobi_amount  = v_contract_amt
     where id = v_client;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception '0426: expected to update exactly one client, updated %', v_n;
    end if;
    raise notice '0426: Emaar client EOBI fallback % -> %', v_was, v_contract_amt;
  end if;

  -- The assertion that matters is NOT that the client row now says 400 — that
  -- is the write restating itself. It is that the two arms of the resolution
  -- rule can no longer disagree for this client, which is the defect.
  if exists (
    select 1
    from public.contracts k
    where k.client_id = v_client
      and k.status = 'active'
      and k.eobi_deduction
      and k.eobi_amount is not null
      and k.eobi_amount is distinct from (select eobi_amount from public.clients where id = v_client)
  ) then
    raise exception
      '0426: an active Emaar contract still names an EOBI amount different from the client fallback';
  end if;

  -- And that history was left alone. A forward change that quietly altered a
  -- disbursed payslip would be the opposite of what was asked for.
  select count(*) into v_n
  from public.payslips p
  join public.employees e on e.id = p.employee_id
  where e.client_id = v_client and p.disbursed and p.eobi <> 370;
  if v_n <> 0 then
    raise exception
      '0426: % disbursed Emaar payslips no longer read 370 — history was modified', v_n;
  end if;
end;
$$;

-- This file creates no function and takes no uuid parameter, so it cannot open
-- a tenant hole of its own. Run anyway, for the reason given in 0425.
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
