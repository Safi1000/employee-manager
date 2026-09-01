-- 0274 — G4. Move Ironclad Munitions off Head Office, and take its posted
-- region dimension with it.
--
-- WHICH REGION, AND HOW THAT WAS DECIDED
--
-- R1 is ICT / Rawalpindi. The sandbox's corresponding region is **North Region
-- (NR)**, and that is read off the data rather than assumed from the name:
--
--   North Region   Citadel Bank Ltd      Jinnah Avenue, Islamabad
--                  Orion Mall Management Sector F-10, Islamabad
--                  Slate Holdings        Bahria Town, Rawalpindi
--   South Region   Delta Port Authority  West Wharf, Karachi
--                  Palm Grove Resorts    Clifton, Karachi
--                  Vertex Labs           Sundar Industrial Estate, Lahore
--
-- North Region is the only one holding ICT/RWP clients, and **Ironclad
-- Munitions' own billing address is "Wah Cantt, Rawalpindi"** — it belongs there
-- on its own address, not merely by elimination.
--
-- WHY THE CHECK EXISTS AND WHY IT IS KEPT
--
-- `no_billing_clients_on_head_office` enforces A10: head office is a cost
-- centre whose cost is apportioned to the regions by revenue. A billing client
-- sitting on HO earns revenue at the very place that is supposed to have none of
-- its own, so the apportionment divides by a base that includes its own target.
-- Fixing the datum does not make the check unnecessary — it makes it green,
-- which is a different thing. It stays.
--
-- SCOPE, MEASURED FIRST: 2 invoices (180,000.00 across 4 journal lines), 0
-- employees, 0 invoice_payments, 0 expenses. Nothing else references the client
-- with a branch.
--
-- POSTED LINES ARE NOT UPDATED. The 2 invoice entries are reversed and reposted
-- in the current period with the correct branch, the same discipline 0265 used.

do $$
declare
  v_co     uuid := (select id from public.companies where name = 'SANDBOX TESTING ORG');
  v_client uuid;
  v_ho     uuid;
  v_nr     uuid;
  r        record;
  v_lines  jsonb;
  v_moved  int := 0;
begin
  if v_co is null then
    raise notice '0274: SANDBOX TESTING ORG not present; nothing to do';
    return;
  end if;

  select id into v_client from public.clients where company_id = v_co and name = 'Ironclad Munitions';
  select id into v_ho from public.branches where company_id = v_co and is_head_office;
  select id into v_nr from public.branches where company_id = v_co and code = 'NR';

  if v_client is null or v_ho is null or v_nr is null then
    raise exception '0274: client %, head office %, north region % — one is missing', v_client, v_ho, v_nr;
  end if;

  if (select branch_id from public.clients where id = v_client) = v_nr then
    raise notice '0274: already on North Region';
  end if;

  update public.clients set branch_id = v_nr where id = v_client and branch_id is distinct from v_nr;
  update public.invoices set branch_id = v_nr where client_id = v_client and branch_id is distinct from v_nr;

  -- Any LIVE entry still carrying the head-office branch: reverse, and repost
  -- the same lines with the region corrected. The lines are copied rather than
  -- rebuilt, so nothing but the branch can change.
  for r in
    select je.id as entry_id, je.entry_date, je.description, je.source_table, je.source_id
      from public.journal_entries je
     where je.company_id = v_co
       and je.is_reversal = false
       and not exists (select 1 from public.journal_entries x where x.reversal_of_entry_id = je.id)
       and exists (select 1 from public.journal_lines jl
                    where jl.journal_entry_id = je.id and jl.client_id = v_client
                      and jl.branch_id = v_ho)
  loop
    select jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'account_id', jl.account_id,
               'debit', jl.debit, 'credit', jl.credit,
               'region', v_nr,
               'client_id', jl.client_id, 'employee_id', jl.employee_id,
               'partner_id', jl.partner_id, 'contract_id', jl.contract_id,
               'cost_center', jl.cost_center)))
      into v_lines
      from public.journal_lines jl where jl.journal_entry_id = r.entry_id;

    perform public.reverse_journal_for_source(v_co, r.source_table, r.source_id, r.entry_date);
    perform public.post_journal(
      v_co, current_date,
      r.description || ' (region corrected to North — 0274)',
      r.source_table, r.source_id, false, v_lines, v_nr);
    v_moved := v_moved + 1;
  end loop;

  raise notice '0274: % entries reposted to North Region', v_moved;

  -- Prove it, rather than trusting the update.
  if exists (select 1 from public.clients c join public.branches b on b.id = c.branch_id
              where c.company_id = v_co and b.is_head_office) then
    raise exception '0274: a billing client is still on head office';
  end if;
  if exists (select 1 from public.journal_lines jl
              join public.journal_entries je on je.id = jl.journal_entry_id
             where je.company_id = v_co and je.is_reversal = false
               and not exists (select 1 from public.journal_entries x where x.reversal_of_entry_id = je.id)
               and jl.client_id = v_client and jl.branch_id = v_ho) then
    raise exception '0274: live journal lines for Ironclad Munitions still carry the head-office branch';
  end if;
end $$;

do $$
declare v_ok boolean;
begin
  select passed into v_ok from public.ledger_checks(
    (select id from public.companies where name = 'SANDBOX TESTING ORG'))
   where check_name = 'no_billing_clients_on_head_office';
  if not coalesce(v_ok, true) then
    raise exception '0274: no_billing_clients_on_head_office is still red';
  end if;
  raise notice '0274: no_billing_clients_on_head_office is green';
end $$;