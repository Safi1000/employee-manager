-- 0425: turn on HMC Taxila's client-level EOBI fallback at 400, so that every
-- HMC guard resolves to the deduction their CONTRACT already names.
--
-- REPORTED AS: "all HMC guards need to be deducted 400 EOBI, some of them are
-- already done so don't repeat it".
--
-- WHAT WAS ACTUALLY WRONG. EOBI is not a figure anybody types onto a payslip.
-- It is derived at payroll time by resolveEobiAmount(contract, client):
--
--     contract.eobi_deduction AND contract.eobi_amount is not null
--         -> contract.eobi_amount
--     else client.eobi_enabled ? client.eobi_amount : 0
--
-- HMC Taxila's contract (77cc83c9) already carried eobi_deduction = true and
-- eobi_amount = 400. That is the half that was "already done". But only TWO of
-- the hundred-and-nine live guards posted to HMC carry `employees.contract_id`
-- pointing at it. The other hundred-and-seven have a null contract_id, fall
-- through to the client, and the client read eobi_enabled = false — so they
-- resolved to ZERO and were never going to be deducted anything.
--
-- Nothing about that state announces itself. The contract says 400, the screen
-- that shows the contract says 400, and the guards silently resolve to 0
-- because of a column on a different table that no longer has a form.
--
-- "DON'T REPEAT IT" IS STRUCTURALLY GUARANTEED, and it is worth saying why
-- rather than trusting it. EOBI here is a RESOLVED FLAT AMOUNT per employee per
-- month, not an accumulating deduction: the payroll screen asks "what is this
-- person's EOBI" and gets one number. There is no path on which a guard is
-- deducted 400 twice, and the two already attached to the contract keep
-- resolving to 400 through the contract, unchanged, because the contract arm is
-- tested first. So this file cannot double anybody.
--
-- WHY THE CLIENT FALLBACK AND NOT THE 107 CONTRACT LINKS. Attaching a hundred
-- and seven guards to a contract is an ASSIGNMENT operation. It changes which
-- contract a guard is posted under, and it is not something that should happen
-- as a side effect of a request about a payroll deduction — the blast radius of
-- one config row and of a hundred and seven employee rows are not comparable,
-- and only one of them is reversible by reading this file backwards.
--
-- Checked before choosing: contract.allowed_leaves_per_month = 4 and
-- client.allowed_leaves_per_month = 4, so the two routes resolve leave
-- identically and this choice changes EOBI and nothing else.
--
-- DEFERRED, and it is the real defect: 107 of HMC's 109 live guards have a null
-- employees.contract_id. Whoever owns assignment should decide whether guards
-- are meant to carry a contract link at all — if they are, these should be
-- attached and this fallback can be turned off again; if they are not, the
-- client fallback is the right home for the figure and the "no longer editable"
-- note on clients.eobi_* is wrong, because this is the third thing that needed
-- it. Not settled here.
--
-- NO PAYSLIP IS REWRITTEN BY THIS FILE. The deduction is resolved when a
-- payslip is generated or re-saved on the Payroll screen, and net_salary is
-- computed from it there (net = final_salary − income_tax − eobi − advance).
-- Writing payslips.eobi directly would be the wrong layer AND a half-write:
-- net_salary is a plain column, not generated and not maintained by any
-- trigger, so a hand-set eobi would print on the payslip and not reduce what
-- the guard is paid. HMC's one existing August payslip (eobi 0, NOT disbursed)
-- picks up the 400 when it is next saved.

do $$
declare
  v_client        uuid;
  v_name          text;
  v_was_enabled   boolean;
  v_was_amount    numeric;
  v_contract_amt  numeric;
  v_zero_after    int;
  v_live          int;
  v_n             int;
begin
  -- Resolve by client_code, which a human can check by eye, rather than by a
  -- uuid that has to be trusted.
  select c.id, c.name, c.eobi_enabled, coalesce(c.eobi_amount, 0)
    into v_client, v_name, v_was_enabled, v_was_amount
  from public.clients c
  where c.client_code = 'CLI-0041';

  if v_client is null then
    raise exception '0425: no client with code CLI-0041';
  end if;
  if v_name not ilike '%HMC%' then
    raise exception '0425: CLI-0041 is "%", which is not HMC — refusing', v_name;
  end if;

  -- The contract is the authority for the figure. Take 400 FROM it rather than
  -- restating the number, so this file cannot disagree with the contract it is
  -- propagating.
  select k.eobi_amount into v_contract_amt
  from public.contracts k
  where k.client_id = v_client
    and k.status = 'active'
    and k.eobi_deduction
    and k.eobi_amount is not null
  order by k.start_date desc
  limit 1;

  if v_contract_amt is null then
    raise exception
      '0425: no active HMC contract names an EOBI amount — the figure has no source';
  end if;
  if v_contract_amt <> 400 then
    raise exception
      '0425: the HMC contract names EOBI %, not the 400 this change was asked for', v_contract_amt;
  end if;

  -- Idempotent: replaying against an already-migrated database must be a no-op,
  -- not a second write that looks like a change in the audit log.
  if v_was_enabled and v_was_amount = v_contract_amt then
    raise notice '0425: HMC already resolves to % at the client — nothing to do', v_contract_amt;
  else
    update public.clients
       set eobi_enabled = true,
           eobi_amount  = v_contract_amt
     where id = v_client;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception '0425: expected to update exactly one client, updated %', v_n;
    end if;
  end if;

  -- ------------------------------------------------------------------------
  -- Verify the thing that can break: that every live HMC guard now RESOLVES to
  -- 400. Checking that the client row says 400 would only measure the update
  -- that was just made — the question is whether the resolution rule, contract
  -- arm and fallback arm together, now answers 400 for all of them.
  -- ------------------------------------------------------------------------
  select count(*) into v_live
  from public.employees e
  where e.client_id = v_client
    and e.lifecycle_state not in ('terminated', 'fired', 'left', 'absconded');

  select count(*) into v_zero_after
  from public.employees e
  left join public.contracts k on k.id = e.contract_id
  left join public.clients  c on c.id = e.client_id
  where e.client_id = v_client
    and e.lifecycle_state not in ('terminated', 'fired', 'left', 'absconded')
    and case
          when k.eobi_deduction and k.eobi_amount is not null then k.eobi_amount
          when c.eobi_enabled then coalesce(c.eobi_amount, 0)
          else 0
        end <> 400;

  if v_zero_after <> 0 then
    raise exception
      '0425: % of % live HMC guards still do not resolve to 400 EOBI', v_zero_after, v_live;
  end if;

  raise notice '0425: all % live HMC guards resolve to 400 EOBI (was: 2 via contract, 107 at zero)', v_live;
end;
$$;

comment on column public.clients.eobi_enabled is
  'Client-level EOBI fallback, used when the employee''s contract does not enable the '
  'deduction — see resolveEobiAmount(). NOT dead legacy: 0425 had to switch this on for '
  'HMC Taxila because 107 of 109 guards carry no contract_id and therefore never reach '
  'the contract arm at all. A guard with no contract link resolves HERE or nowhere.';

-- This file creates no function and takes no uuid parameter, so it cannot open
-- a tenant hole of its own. The assertion is run anyway rather than waived:
-- it costs one query, and a data migration that silently rode along beside a
-- gap somebody else left is exactly the shape of the four incidents the tail
-- exists to prevent.
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
