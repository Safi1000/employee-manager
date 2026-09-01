-- 0247 — Stop writing `reversed` onto the original entry. Derive it.
--
-- DEV ONLY. Full rationale in docs/LEDGER_REVERSAL_STATUS_AUDIT.md.
--
-- A reversed entry is not a modified entry. Nothing about it changed — another
-- entry answers it. Writing a status back onto the original is the habit of
-- editing the record instead of adding to it, and it is what made a posted
-- document impossible to edit at all: reverse_journal_for_source ended with an
-- UPDATE on the original, and enforce_journal_immutable refuses every UPDATE
-- outside a maintenance session, in any period. Creating an invoice worked;
-- editing it was refused, in an open month, with no period ever closed.
--
-- AUDITED FIRST. One function in the database referenced 'reversed' and it was
-- the writer; zero readers in views, policies, indexes, the frontend, Edge
-- Functions or the tests. Only two functions filtered journal_entries.status at
-- all — ledger_payroll_by_client, fixed alone in 0246 because it was returning
-- zero, and reverse_journal_for_source itself. The other fourteen, and the
-- trial-balance screen, already ignore status, which is the correct
-- double-entry behaviour and already the majority one.
--
-- The two representations agreed exactly before this ran: 98 rows marked
-- 'reversed', 98 rows carrying reversal_of_entry_id, zero disagreement in
-- either direction. No reconciliation was needed, only a rewrite.
--
-- `draft` goes too. Zero functions ever wrote it, zero rows held it, and
-- immutability made promotion impossible — a state the system could neither
-- create nor leave is not a state.
--
-- SUPERSEDED IN PART BY 0249, which adds the closed-period reversal date to
-- this function. Read them in order.

create or replace function public.reverse_journal_for_source(
  p_company_id uuid, p_source_table text, p_source_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entry  record;
  v_rev_id uuid;
  v_user   uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  perform public.assert_same_company(p_company_id);

  begin v_user := auth.uid(); exception when others then v_user := null; end;

  for v_entry in
    select je.id, je.description
      from public.journal_entries je
     where je.company_id = p_company_id
       and je.source_table = p_source_table
       and je.source_id = p_source_id
       and je.is_reversal = false
       -- `and je.status = 'posted'` REMOVED. It was a second expression of the
       -- clause below and the reason a posted entry could not be reversed.
       and not exists (
         select 1 from public.journal_entries rev
          where rev.reversal_of_entry_id = je.id)
  loop
    v_rev_id := gen_random_uuid();

    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id,
       is_reversal, posted_by, status, posting_period, reversal_of_entry_id)
    values
      (v_rev_id, p_company_id, p_date,
       v_entry.description || ' (reversal)',
       p_source_table, p_source_id, true, v_user,
       'posted', date_trunc('month', p_date)::date, v_entry.id);

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    select v_rev_id, jl.account_id, jl.credit, jl.debit, jl.branch_id,
           jl.client_id, jl.employee_id, jl.partner_id, jl.contract_id, jl.cost_center
      from public.journal_lines jl
     where jl.journal_entry_id = v_entry.id;

    -- `update journal_entries set status = 'reversed'` REMOVED. This single
    -- statement is what made every posted document uneditable: immutability
    -- refuses every UPDATE outside a maintenance session, so the reversal died
    -- here and took the edit with it.
  end loop;
end;
$function$;

comment on function public.reverse_journal_for_source(uuid, text, uuid, date) is
  'Reverses every un-reversed posted entry for a source row. Does NOT mark the original: "already reversed" is derived from the existence of a row whose reversal_of_entry_id points at it. Writing a status back onto the original made posted documents uneditable, because immutability refuses every UPDATE on journal_entries. See 0247.';

-- ---------------------------------------------------------------------------
-- Backfill the 98 rows, under an EXPLICIT maintenance session.
--
-- This is an UPDATE on journal_entries, which enforce_journal_immutable refuses
-- by design. The hatch is exactly what it is for, and it is opened and closed
-- here in the open rather than left set.
-- ---------------------------------------------------------------------------

do $backfill$
declare
  v_before int;
  v_after  int;
  v_orphan int;
begin
  select count(*) into v_before from public.journal_entries where status = 'reversed';

  -- Prove the two representations agree BEFORE overwriting one of them. If they
  -- ever disagreed, this backfill would be destroying the only record of it —
  -- and would produce a database that looks consistent because it was made
  -- consistent, not because it was.
  select count(*) into v_orphan
    from public.journal_entries je
   where (je.status = 'reversed')
      <> exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = je.id);
  if v_orphan > 0 then
    raise exception
      '0247 ABORTED: % entr(ies) where status and reversal_of_entry_id disagree. The derived form is not equivalent on this data and the backfill would lose information.',
      v_orphan;
  end if;

  perform set_config('app.ledger_maintenance', 'on', true);
  if not public.is_maintenance_session() then
    raise exception '0247 ABORTED: could not open a maintenance session; the backfill cannot run';
  end if;

  update public.journal_entries set status = 'posted' where status = 'reversed';

  perform set_config('app.ledger_maintenance', 'off', true);
  if public.is_maintenance_session() then
    raise exception '0247 ABORTED: maintenance session did not close';
  end if;

  select count(*) into v_after from public.journal_entries where status = 'reversed';
  if v_after <> 0 then
    raise exception '0247 backfill left % row(s) still marked reversed', v_after;
  end if;
  raise notice '0247 backfilled % entries from reversed to posted', v_before;
end
$backfill$;

-- `posted` is the only value the system can produce.
alter table public.journal_entries drop constraint if exists journal_entries_status_chk;
alter table public.journal_entries add constraint journal_entries_status_chk
  check (status = 'posted');

-- ---------------------------------------------------------------------------
-- Verification, in a subtransaction that rolls back its own writes. Both
-- directions: the reversal must WORK (it could not before), and the original
-- must be left untouched.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_client uuid; v_inv uuid; v_msg text;
      v_open date := date_trunc('month', current_date)::date;
      v_entries int; v_revs int; v_after int;
    begin
      perform set_config('app.ledger_maintenance', 'off', true);
      select c.id into v_co from public.companies c
       where exists (select 1 from public.journal_entries je where je.company_id = c.id) limit 1;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      select cl.id into v_client from public.clients cl where cl.company_id = v_co limit 1;
      if v_co is null or v_p is null or v_client is null then
        raise exception '0247 cannot self-test: needs a company with entries, a non-SSA profile and a client';
      end if;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      -- CONTROL: creating a document still posts an entry.
      insert into public.invoices
        (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
         invoice_amount, subtotal, total_due, amount_received, status)
      values (v_co, v_client, '0247-SELFTEST', v_open, v_open,
              (v_open + interval '1 month - 1 day')::date, 50000, 50000, 50000, 0, 'Unpaid')
      returning id into v_inv;

      select count(*) into v_entries from public.journal_entries
       where source_table='invoices' and source_id=v_inv;
      if v_entries < 1 then
        raise exception '0247 CONTROL FAILED: creating an invoice posted no journal entry';
      end if;

      -- THE FIX: editing a posted document now works. This was refused before.
      begin
        update public.invoices set invoice_amount = 60000, subtotal = 60000, total_due = 60000
         where id = v_inv;
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0247 FAILED: editing a posted invoice is still refused (%)', v_msg;
      end;

      select count(*) filter (where is_reversal) into v_revs
        from public.journal_entries where source_table='invoices' and source_id=v_inv;
      if v_revs < 1 then
        raise exception '0247 FAILED: the edit produced no reversal entry, so nothing was reposted';
      end if;

      select count(*) into v_after from public.journal_entries
       where source_table='invoices' and source_id=v_inv and status <> 'posted';
      if v_after > 0 then
        raise exception '0247 FAILED: % entr(ies) carry a status other than posted', v_after;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0247 verification failed: %', v_outcome;
  end if;
end
$verify$;
