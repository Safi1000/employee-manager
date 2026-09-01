-- 0317 — a carry-forward advance posts nothing; a payroll run names its
-- custodians per payslip; and settlement_account refuses a mode it does not
-- recognise instead of guessing.
--
-- THREE CHANGES, ONE THEME: the fall-through was doing the deciding.
--
-- ===========================================================================
-- 1. THE CARRY-FORWARD ADVANCE
-- ===========================================================================
--
-- When a payslip is overpaid — attendance is corrected after the money went
-- out, so Net drops below what was already paid — PayrollManagement writes a
-- marker row into `advances` for the difference, so next month's payroll
-- deducts it. It is a record of who owes what. NO MONEY MOVES.
--
-- It was written with payment_mode = 'Cash', because 'Cash' was the only value
-- the CHECK constraint allowed that did not require a bank account. That is a
-- mode chosen to satisfy a constraint, not to describe an event, and the
-- ledger believed it: journal_on_advance posted
--
--     Dr employee_advances_receivable / Cr <cash>
--
-- crediting cash that never left the building. Worse, with no custodian on the
-- row, settlement_account('Cash', ..., custodian => null) resolved to the
-- undifferentiated cash control — so the credit was not even attributable to a
-- person.
--
-- RULING: a carry-forward advance is a receivable already recognised by the
-- disbursement that created it. It records who owes what, and posts nothing.
--
-- Consequence worth stating rather than discovering later: the employee's debt
-- therefore sits in the ledger as a debit balance on SALARIES PAYABLE (the
-- disbursement paid more than was accrued), not in employee_advances_receivable.
-- The `advances` row is the operational record of it. That is the ruling's
-- direct implication, and it is written down here so the next reader does not
-- have to re-derive it from the absence of an entry.
--
-- ===========================================================================
-- 2. settlement_account's FALL-THROUGH
-- ===========================================================================
--
-- It read:
--
--     when p_payment_mode = 'Cash'    then cash_account_for(...)
--     when p_payment_mode = 'Cheque'
--          and outgoing               then unpresented_cheques
--     else                                 bank_account_gl(...)
--
-- The `else` is not "Bank". It is "Bank, and also every value nobody has
-- thought of, and also NULL". Adding a fourth mode to any of the four tables
-- that call this — advances, expenses, payslips, invoice_payments — would have
-- silently posted it to a bank account, and with a null bank_account_id at
-- that. A default that absorbs the unknown case cannot fail, and a branch that
-- cannot fail is indistinguishable from one that is never checked.
--
-- Every mode is now named, and anything else RAISES. 'Carry-forward' raises
-- too: reaching this function at all means journal_on_advance's skip did not
-- happen, and a mode that settles nothing has no settlement account to return.
--
-- Verified before making it strict — the modes that exist on crm-design
-- (PRODUCTION), across all four calling tables:
--
--   advances .......... Bank 1
--   expenses .......... Bank 3, Cash 3
--   invoice_payments .. Bank 5, Cash 3
--   payslips .......... Bank 38, Cash 10
--
-- No NULLs, no Cheque rows, nothing unrecognised. Strictness refuses nothing
-- that exists. That was measured, not assumed — §11a: a pre-flight must ask
-- whether the deployed code can satisfy the new constraint, not only whether
-- the data does, and here the four callers are the deployed code.
--
-- ===========================================================================
-- 3. THE PER-PAYSLIP CUSTODIAN
-- ===========================================================================
--
-- Shayan: multiple people and multiple modes are used within one run. A
-- run-level custodian parameter would be wrong on its face.
--
-- It turns out the data model already agrees. payslips.custodian_location_id
-- exists, and post_payslip_disbursement ALREADY reads `ps.custodian_location_id`
-- per payslip. The gap is not the schema and not the posting — it is that
-- NOTHING WRITES THE COLUMN. PayrollManagement resolves a custodian, validates
-- it, uses it for the bank_transactions attribution, and then does not put it
-- on the payslip. On crm-design:
--
--   payslips ...................................... 48
--   Cash payslips ................................. 10
--   Cash payslips with NO custodian ................  8
--   payslips carrying a custodian ..................  2
--
-- Those eight are the finding. Every one of them posts its cash credit to the
-- undifferentiated cash control. The frontend fix (same commit) writes the
-- column; this migration adds the gate that makes a run refuse to complete
-- while any of its Cash payslips lacks one, naming which.
--
-- WHAT THE GATE CANNOT DO, STATED PLAINLY
--
-- disburse_payroll_run() HAS NO CALLER. Nothing in src/ invokes it, and
-- payroll_runs is empty on production (0 rows) — payroll is disbursed today
-- through PayrollManagement's per-row and bulk paths, which move the money
-- themselves. This function only flips statuses.
--
-- The gate is still the right place for it: it is the run-level control the
-- ledger will use, and a run that cannot say who handed out its cash is not a
-- run that should be marked disbursed. But it is a guard on a door nobody
-- currently walks through, and calling it "the fix" would be the vacuity this
-- project keeps finding (report 9.6). THE FIX IS THE FRONTEND WRITING THE
-- COLUMN. This is the check that tells us if it stops.
--
-- The gate scopes to `not disbursed`, matching the set the function actually
-- updates, so a legacy payslip cannot block a run for ever.

-- ---------------------------------------------------------------------------
-- 1. Carry-forward as a mode
-- ---------------------------------------------------------------------------

alter table public.advances drop constraint if exists advances_payment_mode_check;
alter table public.advances add constraint advances_payment_mode_check
  check (payment_mode = any (array['Cash', 'Bank', 'Cheque', 'Carry-forward']));

comment on constraint advances_payment_mode_check on public.advances is
  'Carry-forward (0317) is an advance that MOVED NO MONEY — the payroll overpayment marker. journal_on_advance posts nothing for it and settlement_account refuses it.';

create or replace function public.journal_on_advance()
returns trigger
language plpgsql
as $function$
declare v_cr_line jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Every field the posting below reads. See 0256 before shortening this.
    if old.amount           is distinct from new.amount
       or old.branch_id        is distinct from new.branch_id
       or old.custodian_location_id is distinct from new.custodian_location_id
       or old.bank_account_id  is distinct from new.bank_account_id      -- 0276
       or old.payment_mode     is distinct from new.payment_mode
       or old.advance_date     is distinct from new.advance_date
       or old.employee_id      is distinct from new.employee_id
       or old.client_id        is distinct from new.client_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  -- 0317: a Carry-forward advance moved no money and posts nothing. Placed
  -- AFTER the reversal above deliberately: an advance edited from Cash into
  -- Carry-forward must have its original entry reversed and then no new one
  -- written, which is what falling through to here and returning achieves.
  if new.payment_mode = 'Carry-forward' then
    return new;
  end if;

  v_cr_line := jsonb_build_object(
    'account_id', public.settlement_account(new.company_id, new.payment_mode,
                                            new.bank_account_id, new.custodian_location_id, true),
    'debit', 0, 'credit', new.amount);

  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'employee_advances_receivable',
                         'debit', new.amount, 'credit', 0,
                         'employee_id', new.employee_id,
                         'client_id', new.client_id)
    ) || jsonb_build_array(v_cr_line),
    new.branch_id
  );
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. settlement_account names every mode and refuses the rest
-- ---------------------------------------------------------------------------

create or replace function public.settlement_account(
  p_company_id uuid,
  p_payment_mode text,
  p_bank_account_id uuid,
  p_custodian_location_id uuid,
  p_outgoing boolean default true)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_payment_mode = 'Cash' then
    return public.cash_account_for(p_company_id, p_custodian_location_id);
  elsif p_payment_mode = 'Cheque' then
    -- Outgoing cheques sit in Unpresented Cheques until they clear; an INCOMING
    -- cheque is money arriving at the bank, so it settles to the bank account.
    if coalesce(p_outgoing, true) then
      return public.coa_id(p_company_id, 'unpresented_cheques');
    end if;
    return public.bank_account_gl(p_company_id, p_bank_account_id);
  elsif p_payment_mode = 'Bank' then
    return public.bank_account_gl(p_company_id, p_bank_account_id);
  elsif p_payment_mode = 'Carry-forward' then
    raise exception
      'A Carry-forward advance settles nothing and must not be posted (0317)'
      using errcode = '23514',
            hint = 'journal_on_advance skips these rows; reaching settlement_account means that skip was removed.';
  end if;

  -- 0317: this used to be `else bank_account_gl(...)`, which absorbed every
  -- unknown mode AND null into a bank posting with a null account.
  raise exception 'Unrecognised payment mode % — no settlement account exists for it',
    coalesce(p_payment_mode, '<null>')
    using errcode = '23514',
          hint = 'Add the mode to settlement_account deliberately, or fix the caller.';
end;
$function$;

comment on function public.settlement_account(uuid, text, uuid, uuid, boolean) is
  'The GL account money settles through for a payment mode. Cash -> the custodian''s cash account; outgoing Cheque -> Unpresented Cheques; Bank and incoming Cheque -> the bank account. Every other value RAISES (0317) — there is no default branch, because a default absorbs the case nobody thought of.';

-- ---------------------------------------------------------------------------
-- 3. A run refuses to disburse while a Cash payslip has no custodian
-- ---------------------------------------------------------------------------

create or replace function public.disburse_payroll_run(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record; v_count integer; v_missing text;
begin
  -- tenant guard [resolved]: owning company looked up from p_run_id via public.payroll_runs (0242)
  if p_run_id is not null then perform public.assert_same_company((select company_id from public.payroll_runs where id = p_run_id)); end if;

  select * into r from public.payroll_runs where id = p_run_id for update;
  if not found then
    raise exception 'payroll run % not found', p_run_id using errcode = '23503';
  end if;
  if r.status <> 'approved' then
    raise exception 'payroll run must be approved before disbursement (currently %)', r.status
      using errcode = '23514';
  end if;

  -- 0317. Cash reaches a person and the ledger posts to that person's account.
  -- Read PER PAYSLIP, never from a run-level parameter: multiple people and
  -- multiple modes are used within one run. Scoped to `not disbursed`, the same
  -- set the update below touches, so an already-settled legacy payslip cannot
  -- block a run for ever. Names the employees, because "some payslip somewhere"
  -- is not an actionable refusal.
  select string_agg(e.employee_code || ' ' || e.full_name, ', ' order by e.employee_code)
    into v_missing
    from public.payslips p
    join public.employees e on e.id = p.employee_id
   where p.payroll_run_id = p_run_id
     and p.payment_mode = 'Cash'
     and p.custodian_location_id is null
     and not p.disbursed;

  if v_missing is not null then
    raise exception 'Cash payslips with no custodian: %', v_missing
      using errcode = '23514',
            hint = 'Name the office-staff member who hands out the cash on each of these payslips, then disburse.';
  end if;

  update public.payroll_runs
     set status = 'disbursed', disbursed_at = now(), updated_at = now()
   where id = p_run_id;

  update public.payslips
     set disbursed = true,
         disbursed_at = coalesce(disbursed_at, now()),
         status = 'Cleared',
         updated_at = now()
   where payroll_run_id = p_run_id and not disbursed;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

comment on function public.disburse_payroll_run(uuid) is
  'Marks an approved run disbursed. Refuses while any of its undisbursed Cash payslips has no custodian_location_id, naming the employees (0317). NOTE: nothing in the application calls this yet — payroll is disbursed today through PayrollManagement''s own per-row and bulk paths, which move the money themselves. The control that matters for those is the frontend writing payslips.custodian_location_id.';

-- ---------------------------------------------------------------------------
-- PROOF — every claim, in both directions, unwound by a deliberate raise.
--
--   A. settlement_account still resolves the modes that EXIST (Cash with a
--      custodian, Bank), and refuses 'Carry-forward' and a nonsense mode.
--      Both halves matter: a function that refuses everything would pass a
--      test that only checks it refuses.
--   B. a Carry-forward advance posts NO journal entry, and a Cash advance
--      posts one — the positive control, without which "0 entries" only shows
--      the trigger is broken.
--   C. disburse_payroll_run refuses a run whose Cash payslip has no custodian,
--      NAMES that employee, and stops refusing once the custodian is set.
-- ---------------------------------------------------------------------------

do $$
declare
  v_co        uuid;
  v_emp       uuid;
  v_emp_code  text;
  v_loc       uuid;
  v_bank      uuid;
  v_adv       uuid;
  v_run       uuid;
  v_ps        uuid;
  v_cash_acct uuid;
  v_bank_acct uuid;
  v_cf_err    text := null;
  v_bad_err   text := null;
  v_cf_lines  int;
  v_cash_lines int;
  v_refuse    text := null;
  v_accept    text := null;
begin
  select p.company_id, p.employee_id, p.id
    into v_co, v_emp, v_ps
    from public.payslips p
   where p.payment_mode = 'Cash' and p.custodian_location_id is null and not p.disbursed
   limit 1;
  if v_co is null then
    raise notice '0317: no undisbursed cash payslip without a custodian; proof skipped';
    return;
  end if;
  select employee_code into v_emp_code from public.employees where id = v_emp;
  select id into v_loc from public.cash_locations where company_id = v_co limit 1;
  select id into v_bank from public.bank_accounts where company_id = v_co limit 1;
  if v_loc is null or v_bank is null then
    raise notice '0317: company has no cash location or no bank account; proof skipped';
    return;
  end if;

  begin
    -- ---- A. settlement_account, both directions --------------------------
    v_cash_acct := public.settlement_account(v_co, 'Cash', null, v_loc, true);
    v_bank_acct := public.settlement_account(v_co, 'Bank', v_bank, null, true);

    begin
      perform public.settlement_account(v_co, 'Carry-forward', null, null, true);
    exception when others then v_cf_err := sqlerrm;
    end;
    begin
      perform public.settlement_account(v_co, 'Teleportation', null, null, true);
    exception when others then v_bad_err := sqlerrm;
    end;

    -- ---- B. the advance, both directions ---------------------------------
    insert into public.advances
      (company_id, employee_id, amount, advance_date, payment_mode, notes)
    values
      (v_co, v_emp, 1234, current_date, 'Carry-forward', '0317 proof — carry-forward')
    returning id into v_adv;
    select count(*) into v_cf_lines
      from public.journal_entries
     where source_table = 'advances' and source_id = v_adv;

    -- the positive control: the same row as Cash DOES post.
    update public.advances set payment_mode = 'Cash', custodian_location_id = v_loc
     where id = v_adv;
    select count(*) into v_cash_lines
      from public.journal_entries
     where source_table = 'advances' and source_id = v_adv and not is_reversal;

    -- ---- C. the run gate, both directions --------------------------------
    insert into public.payroll_runs (company_id, period_month, stream, status)
    values (v_co, date_trunc('month', current_date)::date, 'salaried', 'draft')
    returning id into v_run;

    update public.payslips set payroll_run_id = v_run where id = v_ps;
    update public.payroll_runs set status = 'approved' where id = v_run;

    begin
      perform public.disburse_payroll_run(v_run);
    exception when others then v_refuse := sqlerrm;
    end;

    update public.payslips set custodian_location_id = v_loc where id = v_ps;
    begin
      perform public.disburse_payroll_run(v_run);
    exception when others then v_accept := sqlerrm;
    end;

    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0317: the probe failed for the wrong reason: % %', sqlstate, sqlerrm;
      end if;
  end;

  -- A
  if v_cash_acct is null or v_bank_acct is null then
    raise exception '0317: settlement_account returned null for a mode that exists (Cash %, Bank %)',
      v_cash_acct, v_bank_acct;
  end if;
  if v_cf_err is null or v_cf_err !~ 'Carry-forward' then
    raise exception '0317: settlement_account did not refuse Carry-forward (got %)', coalesce(v_cf_err, '<no error>');
  end if;
  if v_bad_err is null or v_bad_err !~ 'Unrecognised payment mode' then
    raise exception '0317: settlement_account did not refuse an unknown mode (got %)', coalesce(v_bad_err, '<no error>');
  end if;

  -- B
  if v_cf_lines <> 0 then
    raise exception '0317: a Carry-forward advance posted % journal entries', v_cf_lines;
  end if;
  if v_cash_lines < 1 then
    raise exception '0317: the Cash control posted nothing — "0 entries" above proves only that the trigger is dead';
  end if;

  -- C
  if v_refuse is null or v_refuse !~ 'no custodian' then
    raise exception '0317: the run gate did not refuse a custodian-less Cash payslip (got %)',
      coalesce(v_refuse, '<accepted>');
  end if;
  if strpos(v_refuse, v_emp_code) = 0 then
    raise exception '0317: the refusal did not name the employee (% not in "%")', v_emp_code, v_refuse;
  end if;
  if v_accept is not null and v_accept ~ 'no custodian' then
    raise exception '0317: the run gate still refused after the custodian was set: %', v_accept;
  end if;

  -- and it unwound
  if exists (select 1 from public.advances where notes = '0317 proof — carry-forward') then
    raise exception '0317: the probe did not unwind';
  end if;

  raise notice
    '0317: settlement_account resolves Cash and Bank, refuses Carry-forward and unknown modes; a Carry-forward advance posts 0 entries while the same row as Cash posts %; the run gate refused naming % and stopped refusing once the custodian was set',
    v_cash_lines, v_emp_code;
end $$;
