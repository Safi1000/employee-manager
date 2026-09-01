-- 0249 — B: a reversal posts in the period the correction is made, not the
-- period that was wrong.
--
-- DEV ONLY.
--
-- WHY THIS IS ONE CHANGE AND NOT FIFTEEN
--
-- All 15 call sites pass the ORIGINAL date: journal_on_invoice passes
-- coalesce(old.period_start, old.invoice_date), journal_on_payslip passes
-- old.period_month, journal_on_expense passes old.expense_date, and so on. The
-- decision they are each making is identical, so it belongs in the function
-- they all call rather than copied into fifteen trigger bodies where it can
-- drift. Every caller keeps passing the original date; that date is now the
-- INPUT to the decision rather than the answer.
--
-- THE RULE, AND WHERE IT DEPARTS FROM THE LITERAL INSTRUCTION
--
-- Instruction: "the reversal date is the date the correction is made, not the
-- date of the original."
--
-- Applied unconditionally that breaks policy A4. Editing a July invoice on
-- 31 August, while July is still OPEN, would move the reversal into August
-- while the repost stays in July — so July is overstated by the original and
-- August carries a stray credit. Revenue is recognised at the service month
-- (A4), and an open month should absorb its own correction.
--
-- So the rule implemented is:
--
--   original period CLOSED -> reverse at current_date. The correction lands in
--                             the period where the error was found, which is
--                             the only period it legally can, and this is what
--                             lets the period lock be absolute.
--   original period OPEN   -> reverse at the original date. The correction
--                             stays in its own month and the month's figures
--                             stay right.
--
-- Flagged rather than assumed, and accepted on review. If the reversal is ever
-- wanted at current_date unconditionally, it is the single `case` below.
--
-- WHAT THE CLOSED-PERIOD PATH ACTUALLY REACHES
--
-- Not document edits. Editing a document whose month has been closed is refused
-- by the SOURCE TABLE's own period lock before any trigger runs, which is
-- correct — the row itself cannot be edited in a closed month. The branch below
-- is reached only by paths that reverse a closed-period journal without
-- touching a locked source row, and 0250 refuses those at the door. It stays as
-- defence in depth, and supabase/tests/batch_reposts_closed_month.sql asserts
-- it is unreachable from the three month-batch RPCs.

create or replace function public.reverse_journal_for_source(
  p_company_id uuid, p_source_table text, p_source_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entry    record;
  v_rev_id   uuid;
  v_user     uuid;
  v_rev_date date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  begin v_user := auth.uid(); exception when others then v_user := null; end;

  -- p_date is the ORIGINAL date. A closed month cannot receive the reversal, so
  -- the correction moves to today; an open month keeps it, so the month absorbs
  -- its own correction and A4 is preserved.
  v_rev_date := case
                  when public.is_period_closed(p_company_id, p_date) then current_date
                  else p_date
                end;

  for v_entry in
    select je.id, je.description
      from public.journal_entries je
     where je.company_id = p_company_id
       and je.source_table = p_source_table
       and je.source_id = p_source_id
       and je.is_reversal = false
       and not exists (
         select 1 from public.journal_entries rev
          where rev.reversal_of_entry_id = je.id)
  loop
    v_rev_id := gen_random_uuid();

    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id,
       is_reversal, posted_by, status, posting_period, reversal_of_entry_id)
    values
      (v_rev_id, p_company_id, v_rev_date,
       v_entry.description || ' (reversal)'
         || case when v_rev_date <> p_date
                 then ' — original period ' || to_char(p_date, 'YYYY-MM') || ' is closed'
                 else '' end,
       p_source_table, p_source_id, true, v_user,
       'posted', date_trunc('month', v_rev_date)::date, v_entry.id);

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    select v_rev_id, jl.account_id, jl.credit, jl.debit, jl.branch_id,
           jl.client_id, jl.employee_id, jl.partner_id, jl.contract_id, jl.cost_center
      from public.journal_lines jl
     where jl.journal_entry_id = v_entry.id;
  end loop;
end;
$function$;

comment on function public.reverse_journal_for_source(uuid, text, uuid, date) is
  'Reverses every un-reversed posted entry for a source row. p_date is the ORIGINAL date; the reversal is dated there if that period is open, or at current_date if it is closed, so a correction to a locked month lands in the month the correction was made. Does not mark the original — "already reversed" is derived from reversal_of_entry_id. See 0247, 0249.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_client uuid; v_inv uuid; v_msg text;
      v_open date := date_trunc('month', current_date)::date;
      v_rev_period date;
    begin
      perform set_config('app.ledger_maintenance', 'off', true);

      -- The company must have BOTH a client and a non-SSA profile, or the suite
      -- cannot act as a tenant and every call fails on the tenant guard rather
      -- than on the thing under test.
      select c.id into v_co from public.companies c
       where exists (select 1 from public.clients cl where cl.company_id = c.id)
         and exists (select 1 from public.profiles p
                      where p.company_id = c.id
                        and coalesce(p.role::text,'') <> 'super_super_admin')
       limit 1;
      if v_co is null then
        raise exception '0249 cannot self-test: no company has both a client and a non-SSA profile';
      end if;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      select cl.id into v_client from public.clients cl where cl.company_id = v_co limit 1;

      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);
      if public.current_company_id() is distinct from v_co then
        raise exception '0249 self-test ABORTED: current_company_id() is %, expected %',
          public.current_company_id(), v_co;
      end if;

      -- CONTROL: with the original period OPEN, the reversal must STAY in it.
      insert into public.invoices
        (company_id, client_id, invoice_number, invoice_date, period_start, period_end,
         invoice_amount, subtotal, total_due, amount_received, status)
      values (v_co, v_client, '0249-OPEN', v_open, v_open,
              (v_open + interval '1 month - 1 day')::date, 50000, 50000, 50000, 0, 'Unpaid')
      returning id into v_inv;
      update public.invoices set invoice_amount = 60000, subtotal = 60000, total_due = 60000
       where id = v_inv;

      select je.posting_period into v_rev_period
        from public.journal_entries je
       where je.source_table='invoices' and je.source_id=v_inv and je.is_reversal
       order by je.created_at desc limit 1;
      if v_rev_period is null then
        raise exception '0249 CONTROL FAILED: editing an invoice produced no reversal at all';
      end if;
      if v_rev_period <> v_open then
        raise exception '0249 FAILED: open-period reversal landed in % but should stay in %',
          v_rev_period, v_open;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0249 verification failed: %', v_outcome;
  end if;
end
$verify$;
