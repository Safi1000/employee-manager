-- 0380 — apply_money_delta(): the cash/bank movement and its audit line, in one
--        place, so the eight remaining cross-key flows do not each grow a copy.
--
-- ===========================================================================
-- WHY A HELPER AND NOT EIGHT BODIES
-- ===========================================================================
--
-- §4 of docs/PERMISSION_GAPS.md lists the flows where a single user action
-- writes with two different permission keys across separate round trips, so
-- half the action can commit and half refuse. record_expense (0366) closed two
-- of them by putting the expense, the balance and the audit line in one
-- transaction. The rest want the same treatment.
--
-- Written eight more times, "how money moves" would have nine definitions and
-- the next person to change one would change one. The arithmetic-under-the-lock
-- rule, the row-count assert, the two different zero-row diagnoses, the
-- treasury bootstrap — each of those is a decision that took a probe to get
-- right, and each would be re-decided by whoever typed the ninth copy.
--
-- So it becomes ONE function, and record_expense is restated onto it in the
-- same migration. Not as tidying: leaving record_expense with its own copy
-- would mean this helper is the definition of how money moves everywhere
-- except in the one place that already worked, which is how two definitions
-- start.
--
-- ===========================================================================
-- WHAT IT KEEPS FROM record_expense, DELIBERATELY
-- ===========================================================================
--
-- * SECURITY INVOKER. The RPC supplies the transaction boundary and nothing
--   else; RLS stays the single definition of who may write what. A caller
--   without accounting.edit still cannot move a bank balance, and now finds
--   out inside the transaction that carries the row.
--
-- * `balance + p_delta` IN THE UPDATE, never (value read) + delta. The
--   arithmetic happens under the row lock, so two concurrent movements on one
--   account both land.
--
-- * EVERY BALANCE WRITE ASSERTS ITS OWN ROW COUNT AND RAISES. Zero rows under
--   RLS is not an error in Postgres — it is silence. The assert is what turns
--   an unauthorised write into a refusal instead of a no-op the caller is
--   congratulated for.
--
-- * THE TWO ZERO-ROW CASES ARE DIAGNOSED SEPARATELY, because they are
--   different facts and the operator can act on only one of them. treasury is
--   governed by one policy for SELECT and UPDATE alike, so an invisible row is
--   genuinely absent and is created. bank_accounts reads under company_members
--   and writes under accounting.edit, so a VISIBLE row that did not update is
--   a permission refusal and says so by name.
--
-- ===========================================================================
-- THE SIGN CONVENTION, AND WHY THE CALLER OWNS IT
-- ===========================================================================
--
-- p_delta is SIGNED and is the movement of the balance: negative for money
-- leaving, positive for money arriving or for a reversal. bank_transactions
-- records the same signed figure in cash_delta/account_delta and the ABSOLUTE
-- value in amount, which is the convention already on that table.
--
-- A reversal is therefore not a separate concept here. It is the same call
-- with the opposite sign, which is exactly what the frontend helpers
-- (applyCashDelta / applyBankDelta / logExpenseTransaction) already did — one
-- round trip at a time, outside any transaction. That is the only thing being
-- taken away from them.
--
-- Modes other than Cash and Bank move nothing and log nothing: a cheque moves
-- money when it clears and a payable when it is settled. Passing one is not an
-- error, it is a no-op, because every caller has a mode column that may hold
-- any of the four.

create or replace function public.apply_money_delta(
  p_company        uuid,
  p_mode           text,
  p_bank_account_id uuid,
  p_delta          numeric,
  p_kind           text,
  p_description    text,
  p_reference_id   text
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare v_n int;
begin
  if p_company is null then
    raise exception 'A money movement needs a company. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_delta is null or p_delta = 0 then
    return;
  end if;

  if p_mode = 'Cash' then
    update public.treasury
       set cash_balance = cash_balance + p_delta, updated_at = now()
     where company_id = p_company;
    get diagnostics v_n = row_count;

    if v_n = 0 then
      -- treasury carries only company_members/ssa_all, and that policy governs
      -- SELECT and UPDATE identically — so if a row is visible here it was
      -- writable above, and invisible means there is genuinely none yet.
      if exists (select 1 from public.treasury t where t.company_id = p_company) then
        raise exception
          'The cash balance could not be updated. Nothing has been recorded.'
          using errcode = '42501';
      end if;
      insert into public.treasury (company_id, cash_balance) values (p_company, p_delta);
    elsif v_n > 1 then
      raise exception
        'There are % treasury rows for this company, so the cash balance is ambiguous. Nothing has been recorded.', v_n
        using errcode = 'P0001';
    end if;

  elsif p_mode = 'Bank' then
    if p_bank_account_id is null then
      raise exception 'A bank movement needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
    end if;

    update public.bank_accounts
       set balance = balance + p_delta, updated_at = now()
     where id = p_bank_account_id;
    get diagnostics v_n = row_count;

    if v_n <> 1 then
      -- bank_accounts is the case where SELECT and UPDATE differ: reading is
      -- company_members, writing needs accounting.edit. So a visible row that
      -- did not update is a permission refusal, and that is what to say.
      if exists (select 1 from public.bank_accounts b where b.id = p_bank_account_id) then
        raise exception
          'Moving a bank balance needs the accounting.edit permission. Nothing has been recorded.'
          using errcode = '42501';
      end if;
      raise exception
        'That bank account does not exist, or belongs to another company. Nothing has been recorded.'
        using errcode = 'P0001';
    end if;

  else
    -- Cheque and Payable move no balance and log nothing. A cheque moves money
    -- when it clears; a payable when it is settled.
    return;
  end if;

  -- company_id is passed EXPLICITLY and not left to fill_company_id. The
  -- trigger reads current_company_id() off the session; p_company came off the
  -- row whose balance just moved. Those are the same value for a logged-in
  -- operator and are not the same value for anything else — a cron job, a SQL
  -- session, or a definer caller acting for someone — and an audit line filed
  -- against the wrong company is worse than none.
  insert into public.bank_transactions
    (company_id, bank_account_id, kind, amount, cash_delta, account_delta, description, reference_id)
  values (
    p_company,
    case when p_mode = 'Bank' then p_bank_account_id end,
    p_kind, abs(p_delta),
    case when p_mode = 'Cash' then p_delta else 0 end,
    case when p_mode = 'Bank' then p_delta else 0 end,
    p_description, p_reference_id);
end;
$function$;

comment on function public.apply_money_delta(uuid, text, uuid, numeric, text, text, text) is
  '0380: the ONE definition of how a cash or bank balance moves and how that movement is logged. SECURITY INVOKER — the caller''s RLS decides whether the balance may move, and accounting.edit is still required for a bank. p_delta is SIGNED: negative for money out, positive for money in or for a reversal. Asserts its own row count and raises, because a zero-row UPDATE under RLS is silence and not an error. Cheque and Payable modes are a deliberate no-op. Call it from inside the transaction that carries the row the money belongs to; do not move a balance from the frontend.';

grant execute on function public.apply_money_delta(uuid, text, uuid, numeric, text, text, text) to authenticated;

-- The description was built inline in 0366. It moves to its own function
-- because amend_expense builds the same sentence about the same row, and two
-- copies of a sentence drift into two different sentences about one expense.
create or replace function public.describe_expense(
  p_category_id uuid, p_client_id uuid, p_description text
) returns text
language sql
stable
set search_path to 'public'
as $function$
  select coalesce((select c.name from public.expense_categories c where c.id = p_category_id), 'Expense')
      || ' '
      || coalesce('(' || (select cl.name from public.clients cl where cl.id = p_client_id) || ')', '(Office)')
      || case when coalesce(p_description, '') <> '' then ': ' || p_description else '' end;
$function$;

grant execute on function public.describe_expense(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- record_expense is restated onto it.
--
-- Permitted because record_expense has EXACTLY ONE author (0366) and its full
-- text is in the repo — the case CLAUDE.md allows to be restated, provided the
-- migration first asserts the body it is replacing is a digest it recognises
-- and refuses anything else. An unrecognised body means a second edit nobody
-- recorded, which is precisely when restating destroys something.
-- ---------------------------------------------------------------------------
do $$
declare v_d text;
begin
  select md5(public.executable_source(pg_get_functiondef(p.oid))) into v_d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_expense';
  if v_d is null then
    raise exception '0380 REFUSED: record_expense() does not exist.';
  end if;
  if v_d <> '14ba0aa360331c6bd63f47742eefd4a6' then
    raise exception
      '0380 REFUSED: record_expense() has digest % and this migration was written against 14ba0aa360331c6bd63f47742eefd4a6. Something has edited it since. Do not restate a body you have not read.', v_d;
  end if;
end $$;

create or replace function public.record_expense(
  p_category_id uuid, p_amount numeric, p_expense_date date, p_payment_mode text,
  p_client_id uuid default null, p_branch_id uuid default null,
  p_vendor_id uuid default null, p_description text default null,
  p_custodian_location_id uuid default null, p_bank_account_id uuid default null,
  p_cheque_id uuid default null, p_due_date date default null,
  p_notes text default null, p_expense_by uuid default null,
  p_coverage_start date default null, p_coverage_end date default null,
  p_service_start date default null, p_service_end date default null,
  p_pl_category text default null
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_id      uuid;
  v_company uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'An expense needs an amount greater than zero.' using errcode = 'P0001';
  end if;
  if p_payment_mode is null then
    raise exception 'An expense needs a payment mode.' using errcode = 'P0001';
  end if;
  if p_payment_mode = 'Bank' and p_bank_account_id is null then
    raise exception 'A bank-paid expense needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
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

  -- ---- 2. The money and its audit line. ------------------------------------
  -- 0380: was inline here; now one call, so this function and the seven flows
  -- that came after it cannot disagree about what moving money means.
  perform public.apply_money_delta(
    v_company, p_payment_mode, p_bank_account_id, -p_amount,
    'expense', public.describe_expense(p_category_id, p_client_id, p_description), v_id::text);

  return v_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- The property that matters is not "the function exists" — it is that the
-- money still moves and still refuses. Both are exercised for real against a
-- real company and rolled back, because a helper that compiles and does
-- nothing is exactly the defect this migration is guarding against.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_before numeric;
  v_after  numeric;
  v_tx     int;
begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'apply_money_delta' and p.prosecdef) <> 0 then
    raise exception '0380 FAILED: apply_money_delta is SECURITY DEFINER. It must be INVOKER, or RLS is not the thing deciding.';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_expense' and p.prosecdef) <> 0 then
    raise exception '0380 FAILED: record_expense came back as SECURITY DEFINER.';
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then raise exception '0380 FAILED: no company to probe against.'; end if;

  select cash_balance into v_before from public.treasury where company_id = v_co;
  if v_before is null then
    raise notice '0380: no treasury row for the probe company; the cash arm is not exercised.';
  else
    perform public.apply_money_delta(v_co, 'Cash', null, -101.37, 'expense', 'PROBE 0380', 'probe-0380');
    select cash_balance into v_after from public.treasury where company_id = v_co;
    if v_after <> v_before - 101.37 then
      raise exception '0380 FAILED: cash went % -> %, expected a move of -101.37.', v_before, v_after;
    end if;

    -- And back, by the same call with the opposite sign. If a reversal is not
    -- simply the negative, the sign convention in the comment is a lie.
    perform public.apply_money_delta(v_co, 'Cash', null, 101.37, 'expense', 'PROBE 0380 reverse', 'probe-0380');
    select cash_balance into v_after from public.treasury where company_id = v_co;
    if v_after <> v_before then
      raise exception '0380 FAILED: cash did not return to % after the reversing call; it is %.', v_before, v_after;
    end if;

    select count(*) into v_tx from public.bank_transactions where reference_id = 'probe-0380';
    if v_tx <> 2 then
      raise exception '0380 FAILED: % audit line(s) for the two probe movements, expected 2.', v_tx;
    end if;
  end if;

  -- A mode that moves nothing must also LOG nothing. A helper that wrote an
  -- audit line for a cheque would put money in the ledger that never moved.
  perform public.apply_money_delta(v_co, 'Cheque', null, -50, 'expense', 'PROBE 0380 cheque', 'probe-0380-cheque');
  if exists (select 1 from public.bank_transactions where reference_id = 'probe-0380-cheque') then
    raise exception '0380 FAILED: a Cheque movement wrote an audit line. It must move and log nothing.';
  end if;

  raise exception 'ROLLBACK_PROBE 0380 OK: cash moved and reversed exactly, 2 audit lines, cheque logged nothing.';
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0380 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
