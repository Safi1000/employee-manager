-- 0431 — issued kit becomes the client's cost at month end.
--
-- One journal entry per client per month moving the value of what was issued
-- that month out of inventory and into Cost of Services, on the client the
-- issuance carried.
--
--     Dr  5300 Equipment & Supplies   (client_id = the client)
--     Cr  12xx Inventory — …
--
-- A HANDOVER POSTS NOTHING. The client already absorbed the cost at first
-- issue, and charging again would bill Emaar twice for one uniform.
--
-- COST STAYS WHERE IT WAS ISSUED. kit_events.client_id is frozen at issue, so a
-- guard moving from Emaar to Nova in the same uniform leaves the cost with
-- Emaar. Emaar consumed it.
--
-- ===========================================================================
-- THE PART OF THE SPEC THAT DOES NOT WORK, AND WHAT IS DONE ABOUT IT
-- ===========================================================================
--
-- The spec's reason for all of this is that "client profitability drives
-- partner shares, so kit issued to a client's guards must reduce that client's
-- Net Cash". Posting the journal entry above does NOT achieve that, and would
-- have looked as though it had.
--
-- client_statement_loaded() is what partnership_allocation() reads for per-
-- client net. It computes client cost from exactly two sources:
--
--   1. payslips, split across clients by attendance days
--   2. public.expenses rows carrying a client_id
--
-- IT DOES NOT READ journal_lines AT ALL. A Cost-of-Services line with a
-- client_id on it is invisible to client profitability and therefore to partner
-- shares. The trial balance would have been right and the thing the entry was
-- FOR would have been silently missing — which is this project's defining
-- failure mode, and it is worth noting that nothing would have gone red.
--
-- So this migration also extends client_statement_loaded, and does it in the
-- narrowest way that can work:
--
--   * SCOPED TO source_table = 'kit_issuance'. Payroll and expenses already
--     post their own journal lines with a client_id. Counting every
--     Cost-of-Services line with a client would double every salary and every
--     expense already in that function. Naming the one source cannot.
--   * Folded into the EXPENSES column rather than added as a new one. The
--     function's return signature is consumed by partnership_allocation,
--     draft_profit_allocation and the client statement screen; adding a column
--     changes it for all three.
--
-- ON BOTH BASES, DELIBERATELY. Strictly the cash left when the kit was
-- PURCHASED, not when it was issued, so a pure cash basis would attribute it to
-- nobody. The issuance is the moment the cost becomes attributable to a client
-- at all, and a client basis that ignored it would restore the exact blindness
-- this exists to remove: high-turnover clients looking most profitable because
-- constant re-kitting is invisible.

-- ---------------------------------------------------------------------------
-- 1. THE MONTHLY RUN.
--
-- Takes a month and costs EVERY uncosted issue up to the end of it, grouped by
-- the month it actually happened in — so a missed month is picked up on the
-- next run rather than lost, the same catch-up shape 0399 gave the prepaid
-- release for the same reason.
-- ---------------------------------------------------------------------------
create or replace function public.post_kit_issuance_cost(p_company_id uuid, p_through date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_end    date;
  v_posted int := 0;
  r        record;
  v_lines  jsonb;
  v_total  numeric;
  v_entry  uuid;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_end := (date_trunc('month', coalesce(p_through, current_date)) + interval '1 month - 1 day')::date;
  perform public.ensure_inventory_accounts(p_company_id);

  for r in
    select e.client_id,
           date_trunc('month', e.event_date)::date as month
      from public.kit_events e
     where e.company_id = p_company_id
       and e.event = 'issue'
       and e.costed_month is null
       and e.event_date <= v_end
       and e.client_id is not null
     group by 1, 2
     order by 2, 1
  loop
    -- One credit per inventory account, one debit for the client's total. The
    -- credit side is split because uniforms and weapons sit in different
    -- accounts and a single credit would move value out of an account that
    -- never held it.
    select jsonb_agg(jsonb_build_object('key', k.inventory_key,
                                        'debit', 0, 'credit', k.amt)),
           sum(k.amt)
      into v_lines, v_total
      from (
        select t.inventory_key, sum(e.quantity * e.unit_actual_cost) as amt
          from public.kit_events e
          join public.inventory_item_types t on t.id = e.item_type_id
         where e.company_id = p_company_id and e.event = 'issue'
           and e.costed_month is null
           and e.client_id = r.client_id
           and date_trunc('month', e.event_date)::date = r.month
         group by t.inventory_key
      ) k;

    if coalesce(v_total, 0) <= 0 then
      -- Nothing to charge, but the issues are still settled — otherwise a
      -- zero-value issue is reconsidered every month forever.
      update public.kit_events
         set costed_month = r.month
       where company_id = p_company_id and event = 'issue' and costed_month is null
         and client_id = r.client_id and date_trunc('month', event_date)::date = r.month;
      continue;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'key', 'cos_equipment', 'debit', v_total, 'credit', 0,
      -- THE CLIENT ON THE LINE. This is what makes the entry attributable at
      -- all, and what section 3 below then teaches the profitability function
      -- to read.
      'client_id', r.client_id::text);

    v_entry := public.post_journal(
      p_company_id,
      (r.month + interval '1 month - 1 day')::date,
      'Kit issued — ' || to_char(r.month, 'Mon YYYY') || ' — '
        || coalesce((select name from public.clients where id = r.client_id), 'client'),
      'kit_issuance', r.client_id, false, v_lines,
      (select branch_id from public.clients where id = r.client_id));

    update public.kit_events
       set costed_month = r.month
     where company_id = p_company_id and event = 'issue' and costed_month is null
       and client_id = r.client_id and date_trunc('month', event_date)::date = r.month;

    v_posted := v_posted + 1;
  end loop;

  return v_posted;
end;
$fn$;

comment on function public.post_kit_issuance_cost(uuid, date) is
  '0431: one journal entry per client per month moving issued kit from inventory to Cost of Services, on the client the issuance carried. Idempotent — kit_events.costed_month marks what has been charged — and it CATCHES UP, costing every uncosted issue up to the month given rather than only that month (0399''s lesson). A handover posts nothing: the client absorbed the cost at first issue.';

revoke execute on function public.post_kit_issuance_cost(uuid, date) from anon, public;
grant  execute on function public.post_kit_issuance_cost(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Wire it into the monthly loop. SURGERY: run_monthly_ledger_jobs has been
-- edited by 0350, 0362 and 0400, so no file holds its true text.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_rel text := '    begin
      n := public.release_prepaid_expenses(r.id, v_month);';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'run_monthly_ledger_jobs';
  if v_def is null then raise exception '0431 REFUSED: run_monthly_ledger_jobs does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_rel, ''))) / length(a_rel);
  if v_hits <> 1 then
    raise exception '0431 REFUSED: the release_prepaid_expenses anchor appears % time(s), expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_rel,
'    -- 0431: kit issued this month becomes the client''s cost. Its own handler,
    -- like every other job in this loop, so one company''s failure does not
    -- stop the others.
    begin
      n := public.post_kit_issuance_cost(r.id, v_month);
      v_total := v_total + coalesce(n, 0);
    exception when others then
      v_fail := v_fail + 1;
      v_first := coalesce(v_first, r.name || '' / post_kit_issuance_cost: '' || sqlerrm);
      raise warning ''0431: post_kit_issuance_cost failed for % - %'', r.name, sqlerrm;
    end;

' || a_rel);

  execute v_new;
  raise notice '0431: the monthly loop now charges issued kit to its client.';
end $$;

-- ---------------------------------------------------------------------------
-- 3. AND THE COST REACHES CLIENT PROFITABILITY.
--
-- SURGERY on client_statement_loaded, which several migrations have edited
-- (0349, 0351, 0359 at least), against the live definition with an anchor
-- asserted to appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_exp text := '  exp_client as (
    select client_id, sum(amount) as amt from exp_rows
     where client_id is not null and eff_date between p_start and p_end group by 1
  ),';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'client_statement_loaded';
  if v_def is null then raise exception '0431 REFUSED: client_statement_loaded does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_exp, ''))) / length(a_exp);
  if v_hits <> 1 then
    raise exception '0431 REFUSED: the exp_client anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  v_new := replace(v_def, a_exp,
'  -- 0431. KIT ISSUED TO THIS CLIENT''S GUARDS.
  --
  -- Scoped to source_table = ''kit_issuance'' and to nothing else. Payroll and
  -- expenses post their own journal lines carrying a client_id, and counting
  -- every Cost-of-Services line with a client would double both of them — they
  -- are already in this function, above, from payslips and from expenses.
  -- Naming the one source cannot double-count.
  --
  -- Counted on BOTH bases at the issuance date. Strictly the cash left at
  -- PURCHASE, which belongs to no client, so a pure cash basis would drop it
  -- entirely and restore the blindness this exists to remove: high-turnover
  -- clients looking most profitable because constant re-kitting is invisible.
  kit_client as (
    select jl.client_id, sum(jl.debit - jl.credit) as amt
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     cross join cid
     where je.company_id = cid.company_id
       and je.source_table = ''kit_issuance''
       and je.entry_date between p_start and p_end
       and jl.client_id is not null
     group by 1
  ),
  exp_client as (
    select client_id, sum(amt) as amt from (
      select client_id, sum(amount) as amt from exp_rows
       where client_id is not null and eff_date between p_start and p_end group by 1
      union all
      select client_id, amt from kit_client
    ) u group by 1
  ),');

  execute v_new;
  raise notice '0431: client_statement_loaded now sees issued kit.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Probe. Rollback only.
--
-- THE ASSERTION WORTH HAVING IS THE SECOND ONE. Posting the entry proves the
-- ledger moved; it does NOT prove the thing the entry exists for. Only reading
-- it back out of client_statement_loaded proves that, and before this migration
-- that read returned nothing while the trial balance looked perfect.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_t uuid; v_g uuid; v_cl uuid; v_n int;
  v_before numeric; v_after numeric;
  v_month date := date_trunc('month', current_date)::date;
  v_end   date := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  select d.guard_id, d.client_id into v_g, v_cl
    from public.deployments d join public.employees e on e.id = d.guard_id
   where d.company_id = v_co and d.end_date is null and d.client_id is not null
   order by d.start_date limit 1;
  if v_co is null or v_g is null then raise notice '0431: no fixture; skipped.'; return; end if;

  begin
    select round(coalesce(sum(direct_expenses), 0), 2) into v_before
      from public.client_statement_loaded(v_month, v_end, 'cash', v_co)
     where client_id = v_cl;

    insert into public.inventory_item_types
      (company_id, name, category, issuable, replacement_cost, useful_life_months, sized, inventory_key)
    values (v_co, '0431 probe uniform', 'uniform', true, 3000, 24, true, 'inventory_uniforms')
    returning id into v_t;

    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       to_employee_id, client_id, condition, received_condition, unit_actual_cost, event_date)
    values (v_co, 'issue', null, v_t, 'L', 'new', 2, v_g, v_cl, 'new', 'new', 750, current_date);
    update public.kit_events set issue_id = id
     where item_type_id = v_t and issue_id is null;

    v_n := public.post_kit_issuance_cost(v_co, current_date);
    if v_n <> 1 then
      raise exception '0431 FAILED: costing posted % entries, expected 1.', v_n;
    end if;

    -- Charged exactly once. A second run must find nothing.
    v_n := public.post_kit_issuance_cost(v_co, current_date);
    if v_n <> 0 then
      raise exception '0431 FAILED: re-running charged the same kit again (% entries). costed_month is not settling it.', v_n;
    end if;

    -- THE ONE THAT MATTERS. 2 x 750 = 1,500 must show up as this client''s cost.
    select round(coalesce(sum(direct_expenses), 0), 2) into v_after
      from public.client_statement_loaded(v_month, v_end, 'cash', v_co)
     where client_id = v_cl;

    if round(v_after - v_before, 2) <> 1500.00 then
      raise exception
        '0431 FAILED: the client''s cost moved by % , expected 1500. The journal entry posted and the trial balance balances, and client profitability — which is what partner shares read — cannot see it. That is the whole defect this migration exists to close.',
        round(v_after - v_before, 2);
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0431: probe passed — kit costs once, and the cost reaches the client statement partner shares read.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0431 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
