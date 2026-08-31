-- 0265 — Reverse and repost the six genuinely misposted cash lines.
--
-- Posted lines are immutable. Repointing account_id on 15 posted rows would have
-- been the smaller job and the first exception to the rule this whole project
-- exists to enforce. These are reversals and reposts.
--
-- SIX, NOT FIFTEEN. The G2 investigation (docs/LEDGER_G2_CASH_LOCATION_
-- INVESTIGATION.md) split the 15 lines on the cash control account:
--
--   cat 1  4 lines  +556,000.13  source row carries the location; the reader
--                                ignored it. Repointed by 0264.
--   cat 2  2 lines  -110,010.00  location known only via
--                                bank_transactions.reference_id. Recovered onto
--                                payslips.custodian_location_id by 0263.
--   cat 3  1 line   +150,000.00  the period-split FIXTURE receipt, which carries
--                                no custodian because the fixture wrote none.
--                                Fixture data — fixed in the fixture and logged
--                                as its seventh divergence. NOT corrected here;
--                                it is excluded structurally, by the join on a
--                                non-null custodian, not by an id list.
--   cat 4  8 lines         0.00  already-reversed original/reversal pairs. Two
--                                of the four source rows no longer exist.
--                                Reversing a reversal is nonsense. Left alone.
--
-- HOW THE REPOST IS BUILT
--
-- Not by re-deriving the entry from the source row. The original posting's lines
-- are copied verbatim — amounts, dimensions, branch — and ONLY the account_id of
-- the cash-control line is swapped for
-- cash_account_for(company, custodian_location_id). Re-deriving would encode this
-- migration's model of what the original posting did rather than what it did,
-- which is the exact failure the fixture audit found and named.
--
-- It goes through post_journal(), so the balance check, the line guard (0245)
-- and the empty-entry guard (0254) apply to the correction as to any posting.
--
-- CURRENT PERIOD, both legs. No period is closed (accounting_periods is empty on
-- both environments — checked, not assumed), so reverse_journal_for_source would
-- otherwise reverse into the ORIGINAL month while the repost landed there too.
-- Passing current_date keeps the pair in the month the correction is being made.
--
-- NOTE journal_entries carries no branch_id; branch is a LINE dimension. The
-- branch for post_journal's argument is taken from the cash line itself.

do $$
declare
  r        record;
  v_co     uuid;
  v_cash   uuid;
  v_target uuid;
  v_lines  jsonb;
  v_n      int := 0;
begin
  select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
  select id into v_cash from public.chart_of_accounts
   where company_id = v_co and system_key = 'cash';
  if v_cash is null then
    raise exception 'No cash control account — nothing to correct against';
  end if;

  for r in
    select je.id         as entry_id,
           je.source_table,
           je.source_id,
           je.description,
           jl.branch_id  as branch_id,
           loc.custodian as location_id
      from public.journal_entries je
      join public.journal_lines jl
        on jl.journal_entry_id = je.id and jl.account_id = v_cash
      join lateral (
        select case je.source_table
                 when 'expenses'              then (select e.custodian_location_id
                                                      from public.expenses e where e.id = je.source_id)
                 when 'invoice_payments'      then (select p.custodian_location_id
                                                      from public.invoice_payments p where p.id = je.source_id)
                 when 'payslips_disbursement' then (select ps.custodian_location_id
                                                      from public.payslips ps where ps.id = je.source_id)
                 when 'payslips'              then (select ps.custodian_location_id
                                                      from public.payslips ps where ps.id = je.source_id)
               end as custodian
      ) loc on true
     where je.company_id = v_co
       and je.is_reversal = false
       and loc.custodian is not null
       and not exists (select 1 from public.journal_entries rev
                        where rev.reversal_of_entry_id = je.id)
  loop
    v_target := public.cash_account_for(v_co, r.location_id);
    if v_target = v_cash then
      raise exception
        'Entry %: cash_account_for() resolved back to the control account for location % — that location has no coa_account_id',
        r.entry_id, r.location_id using errcode = '23514';
    end if;

    select jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'account_id', case when jl.account_id = v_cash then v_target else jl.account_id end,
               'debit',       jl.debit,
               'credit',      jl.credit,
               'branch_id',   jl.branch_id,
               'client_id',   jl.client_id,
               'employee_id', jl.employee_id,
               'partner_id',  jl.partner_id,
               'contract_id', jl.contract_id,
               'cost_center', jl.cost_center)))
      into v_lines
      from public.journal_lines jl
     where jl.journal_entry_id = r.entry_id;

    perform public.reverse_journal_for_source(
      v_co, r.source_table, r.source_id, current_date);

    perform public.post_journal(
      v_co, current_date,
      r.description || ' (cash routed to custodian account — 0265)',
      r.source_table, r.source_id, false, v_lines, r.branch_id);

    v_n := v_n + 1;
    raise notice '0265: % % -> location %', r.source_table, r.source_id, r.location_id;
  end loop;

  if v_n <> 6 then
    raise exception
      'Expected exactly 6 misposted entries to correct, processed % — stop and re-read the G2 categories before forcing this.',
      v_n using errcode = '23514';
  end if;
end $$;