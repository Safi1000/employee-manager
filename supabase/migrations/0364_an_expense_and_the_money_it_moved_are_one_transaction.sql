-- 0364 — recording an expense and moving the money it spent become one
--        transaction, under SECURITY INVOKER.
--
-- ===========================================================================
-- THE DEFECT
-- ===========================================================================
--
-- Expenses.tsx wrote an expense in three or four separate round trips:
--
--   1. insert into expenses                                  -> expId
--   2. read bank_accounts.balance / treasury.cash_balance
--   3. write it back as (value read + delta)
--   4. insert into bank_transactions
--
-- Three failure modes, and the middle one is the bad one:
--
--   NOT ATOMIC. Anything after step 1 failing leaves a recorded expense whose
--   money never moved. The operator sees an error and reasonably assumes
--   nothing happened.
--
--   READ-MODIFY-WRITE. Step 2 and step 3 are separate statements, so two
--   expenses paid from one bank account at the same moment each write
--   (their own read + their own delta) and one of them is simply lost.
--
--   THE SILENT UPDATE. `update ... where id = $1` under RLS affects ZERO rows
--   and returns NO error when the policy hides the row. bank_accounts' UPDATE
--   policy is has_perm('accounting.edit'); the SELECT policy is only
--   company_members. So a user with expenses.edit and not accounting.edit
--   READS the balance fine, and the write back vanishes. Nothing raised.
--
-- Traced end to end for that user in Bank mode, against the live policies:
--
--   expenses INSERT           allowed  (perm_write_ins: expenses.edit)
--   bank_accounts UPDATE      SILENTLY ZERO ROWS  (needs accounting.edit)
--   bank_transactions INSERT  refused  (expenses.edit is allowed ONLY for
--                                       kind='expense' AND bank_account_id IS NULL)
--
-- So the user got an error about bank_transactions, the bank balance never
-- moved, and the expense was already committed. The error even pointed at the
-- wrong step.
--
-- ===========================================================================
-- WHY SECURITY INVOKER
-- ===========================================================================
--
-- A DEFINER function would fix atomicity too, and would additionally let the
-- expenses.edit user through — but only by re-implementing, inside the
-- function, the rule about who may write a bank balance. RLS already states
-- that rule once. A definer function also silently takes `branch_scope` OFF the
-- expenses insert, because a definer body is not subject to the caller's
-- policies — which is precisely the hole the four existing definer RPCs have
-- (logged in docs/PERMISSION_GAPS.md).
--
-- INVOKER keeps RLS as the single definition of who may write what, and the
-- function contributes the one thing RLS cannot: a transaction boundary. Same
-- division that made 0320's SECURITY INVOKER load-bearing.
--
-- The honest cost, stated: a bank-mode expense by an expenses.edit-only user
-- STILL refuses. It refuses atomically, with nothing committed and a sentence
-- naming the permission, instead of leaving a recorded expense behind. Better
-- on every axis, and it grants no capability nobody decided to grant.
--
-- Note for the guard detector: tenant_guard_gaps() only inspects SECURITY
-- DEFINER functions, so this one's uuid parameters are not scanned — correctly,
-- because every write below is filtered by the caller's own policies. Adding an
-- assert_same_company() here would be the second statement of a rule.
--
-- ===========================================================================
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
-- ===========================================================================
--
-- Eleven triggers already fire on public.expenses: fill_company_id, region
-- inheritance, the archive check, the not-future-date check, the period lock,
-- cheque capacity, the approval lock, the GL journal, the settlement journal,
-- the disbursement warning and the audit log. That is why this defect never
-- reached the ledger: the journal was always written by trigger, inside the
-- insert, or not at all.
--
-- So the function's whole job is: one door, one transaction, the balance write,
-- and the bank_transactions row. It re-implements none of the eleven.

create or replace function public.record_expense(
  p_category_id           uuid,
  p_amount                numeric,
  p_expense_date          date,
  p_payment_mode          text,
  p_client_id             uuid default null,
  p_branch_id             uuid default null,
  p_vendor_id             uuid default null,
  p_description           text default null,
  p_custodian_location_id uuid default null,
  p_bank_account_id       uuid default null,
  p_cheque_id             uuid default null,
  p_due_date              date default null,
  p_notes                 text default null,
  p_expense_by            uuid default null,
  p_coverage_start        date default null,
  p_coverage_end          date default null,
  p_service_start         date default null,
  p_service_end           date default null,
  -- NULL means "derive from whether a client is named", which is what the Add
  -- Expense form has always done. The fixed-expense approval path carries an
  -- explicit value off the fixed_expenses definition, so it can say so rather
  -- than have this function overrule it.
  p_pl_category           text default null
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_id      uuid;
  v_company uuid;
  v_n       int;
  v_desc    text;
  v_cat     text;
  v_client  text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'An expense needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode is null then
    raise exception 'An expense needs a payment mode.' using errcode = 'P0001';
  end if;

  -- ---- 1. The expense. Every trigger and every policy applies here. --------
  insert into public.expenses (
    category_id, pl_category, client_id, branch_id, vendor_id, description,
    amount, expense_date, payment_mode, custodian_location_id, bank_account_id,
    cheque_id, due_date, payable_status, notes, expense_by,
    coverage_start, coverage_end, service_start, service_end)
  values (
    p_category_id,
    coalesce(
      p_pl_category,
      case when p_client_id is not null then 'cost_of_services' else 'operating_expense' end
    )::public.expense_pl_category,
    p_client_id, p_branch_id, p_vendor_id, p_description,
    p_amount, p_expense_date, p_payment_mode, p_custodian_location_id,
    p_bank_account_id, p_cheque_id, p_due_date,
    case when p_payment_mode = 'Payable' then 'Pending' end,
    p_notes, p_expense_by,
    p_coverage_start, p_coverage_end, p_service_start, p_service_end)
  returning id, company_id into v_id, v_company;

  -- The company is taken off the ROW, not off the session. fill_company_id has
  -- just stamped it, so the balance below cannot move against a different
  -- company from the one the expense landed in — which a session read could.
  if v_company is null then
    raise exception 'The expense was written with no company. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  -- ---- 2. The log line, built once, where the expense is. ------------------
  select c.name into v_cat from public.expense_categories c where c.id = p_category_id;
  select cl.name into v_client from public.clients cl where cl.id = p_client_id;
  v_desc := coalesce(v_cat, 'Expense')
         || ' ' || case when v_client is not null then '(' || v_client || ')' else '(Office)' end
         || case when coalesce(p_description, '') <> '' then ': ' || p_description else '' end;

  -- ---- 3. The money. -------------------------------------------------------
  --
  -- `balance - p_amount` in the UPDATE itself, not (value read) - p_amount.
  -- The arithmetic happens under the row lock, so two concurrent expenses on
  -- one account both land instead of one overwriting the other.
  --
  -- EVERY BALANCE WRITE ASSERTS ITS OWN ROW COUNT AND RAISES. That is what
  -- closes the silent UPDATE: zero rows is no longer indistinguishable from
  -- success, and because this is one transaction the raise takes the expense
  -- above with it.
  if p_payment_mode = 'Cash' then
    update public.treasury
       set cash_balance = cash_balance - p_amount, updated_at = now()
     where company_id = v_company;
    get diagnostics v_n = row_count;

    if v_n = 0 then
      -- treasury carries only company_members/ssa_all, and that policy governs
      -- SELECT and UPDATE identically — so if a row is visible here it was
      -- writable above, and invisible means there is genuinely none yet.
      if exists (select 1 from public.treasury t where t.company_id = v_company) then
        raise exception
          'The cash balance could not be updated. Nothing has been recorded.'
          using errcode = '42501';
      end if;
      insert into public.treasury (company_id, cash_balance) values (v_company, -p_amount);
    elsif v_n > 1 then
      raise exception
        'There are % treasury rows for this company, so the cash balance is ambiguous. Nothing has been recorded.', v_n
        using errcode = 'P0001';
    end if;

  elsif p_payment_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'A bank-paid expense needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
    end if;

    update public.bank_accounts
       set balance = balance - p_amount, updated_at = now()
     where id = p_bank_account_id;
    get diagnostics v_n = row_count;

    if v_n <> 1 then
      -- bank_accounts is the case where SELECT and UPDATE differ: reading is
      -- company_members, writing needs accounting.edit. So a visible row that
      -- did not update is a permission refusal, and that is what to say.
      if exists (select 1 from public.bank_accounts b where b.id = p_bank_account_id) then
        raise exception
          'Paying an expense from a bank account needs the accounting.edit permission — expenses.edit alone cannot move a bank balance. Nothing has been recorded.'
          using errcode = '42501';
      end if;
      raise exception
        'That bank account does not exist, or belongs to another company. Nothing has been recorded.'
        using errcode = 'P0001';
    end if;
  end if;
  -- Cheque and Payable move no balance, which is the behaviour this replaces:
  -- a cheque moves money when it clears, a payable when it is settled.

  -- ---- 4. The audit row. ---------------------------------------------------
  if p_payment_mode in ('Cash', 'Bank') then
    insert into public.bank_transactions
      (bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
    values (
      case when p_payment_mode = 'Bank' then p_bank_account_id end,
      'expense', p_amount,
      case when p_payment_mode = 'Cash' then -p_amount else 0 end,
      case when p_payment_mode = 'Bank' then -p_amount else 0 end,
      v_desc, v_id::text);
  end if;

  return v_id;
end;
$fn$;

comment on function public.record_expense(uuid, numeric, date, text, uuid, uuid, uuid, text, uuid, uuid, uuid, date, text, uuid, date, date, date, date, text) is
  '0364: records an expense and moves the cash or bank balance it spent, as ONE transaction. SECURITY INVOKER on purpose — RLS stays the single definition of who may write what, and this contributes only the transaction boundary. Every balance write asserts its own row count and raises, which is what closes the silent zero-row UPDATE that let an expense be recorded while its money never moved.';

revoke execute on function public.record_expense(uuid, numeric, date, text, uuid, uuid, uuid, text, uuid, uuid, uuid, date, text, uuid, date, date, date, date, text) from public, anon;
grant execute on function public.record_expense(uuid, numeric, date, text, uuid, uuid, uuid, text, uuid, uuid, uuid, date, text, uuid, date, date, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- PROOF 1: it is still SECURITY INVOKER.
--
-- This is the load-bearing property and it is one word. A later `create or
-- replace` that adds `security definer` would compile, work, pass every test,
-- and quietly remove branch_scope from the expenses insert. Assert it.
-- ---------------------------------------------------------------------------
do $$
declare v_def boolean;
begin
  select p.prosecdef into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_expense';
  if v_def is null then raise exception '0364 FAILED: record_expense does not exist.'; end if;
  if v_def then
    raise exception
      '0364 FAILED: record_expense is SECURITY DEFINER. That removes branch_scope and every write policy from the caller and is the opposite of this migration.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- PROOF 2: a failure AFTER the insert rolls the insert back with it.
--
-- WHAT THIS CANNOT PROVE, SAID PLAINLY: an agent session connects as an owner
-- that BYPASSES RLS, so the permission-refusal arm cannot be exercised here —
-- no policy applies to this session at all. What it CAN prove is the mechanism
-- that makes that refusal safe, which is the part that was broken: a raise
-- inside the function undoes the expense insert that preceded it. It is driven
-- through the "Bank mode with no account" arm, which needs no policy to reach.
--
-- It is NOT driven through a non-existent bank id, which was the first attempt:
-- expenses.bank_account_id carries a foreign key, so an all-zeros uuid is
-- refused at step 1 and the rollback being asserted never happens. The message
-- assertion below caught exactly that — the probe would otherwise have passed
-- for a reason with nothing to do with the balance write.
--
-- The version before THAT could not insert at all: fill_company_id reads
-- current_company_id(), which reads auth.uid(), which is null here. Borrowing a
-- real profile's claim for the length of the probe makes the insert succeed,
-- which is the only way the rollback is worth asserting. Transaction-local,
-- cleared at the end, and the whole thing raises anyway.
-- ---------------------------------------------------------------------------
do $probe$
declare
  v_co     uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_uid    uuid;
  v_cat    uuid;
  v_before int;
  v_after  int;
  v_raised text;
begin
  if v_co is null then raise notice '0364: GGS absent; probe skipped.'; return; end if;

  select pr.id into v_uid from public.profiles pr
   where coalesce(pr.view_as_company, pr.company_id) = v_co
   order by pr.created_at limit 1;
  select ec.id into v_cat from public.expense_categories ec where ec.company_id = v_co limit 1;

  if v_uid is null or v_cat is null then
    raise notice '0364: no profile or category for GGS; probe skipped.';
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  select count(*) into v_before from public.expenses where company_id = v_co;

  begin
    perform public.record_expense(
      p_category_id     => v_cat,
      p_amount          => 1,
      p_expense_date    => current_date,
      p_payment_mode    => 'Bank',
      p_bank_account_id => null::uuid,
      p_description     => 'PROBE-0364');
    raise exception '0364 FAILED: a bank expense with no bank account was accepted.';
  exception
    when others then
      v_raised := sqlerrm;
      if v_raised like '0364 FAILED%' then raise; end if;
  end;

  select count(*) into v_after from public.expenses where company_id = v_co;
  perform set_config('request.jwt.claims', '', true);

  -- ASSERT ON THE REFUSAL'S MESSAGE, not on the fact that something raised.
  -- A period lock, a future-date check or a foreign key would also raise, leave
  -- no row, and let this probe pass for a reason that has nothing to do with
  -- the balance write. Three tests passed against the wrong trigger before that
  -- rule existed, and the FK version of this probe was the fourth.
  if v_raised not like '%needs a bank account%' then
    raise exception
      '0364 FAILED: expected the missing-bank-account refusal and got: %', v_raised;
  end if;

  if v_after <> v_before then
    raise exception
      '0364 FAILED: the balance write raised but left % expense row(s) behind. The function is not one transaction, which is the entire point of it.',
      v_after - v_before;
  end if;

  raise notice '0364 probe: refusal left no expense behind (% before, % after). Message: %',
    v_before, v_after, v_raised;
end;
$probe$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0364 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
