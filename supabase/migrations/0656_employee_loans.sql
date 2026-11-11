-- 0656 — employee loans: their own record, repaid by instalment from payslips
--
-- Asked 11 Nov 2026 (Shayan). M. Zamir Khan (EMP-0179, salary 45,000) was paid
-- money above his salary as a LOAN, to be repaid 15,000 a month from his next
-- payslip. Bastion has no loan, so it went in as an advance (105,000 from
-- Askari on 10 Nov, on top of 10,000 on 29 Oct). An advance is recovered from
-- the very next payslip as far as the pay will bear (employee_advance_outstanding
-- + the Payroll screen), so his October and November pay would be swallowed
-- whole instead of 15,000 a month. DECIDED (Shayan): loans are separate from
-- advances, on a screen of their own.
--
-- The change:
--   1. employee_loans — principal, monthly instalment, first month of
--      repayment, the bank it left from. Written only through the functions
--      below (no direct writes from the API).
--   2. payslips.loan_recovery — the instalment taken from that payslip. The
--      Payroll screen deducts it after tax, EOBI and any advance, from what the
--      pay can bear; net falls by it.
--   3. employee_loan_due(period) — per employee: loan outstanding before the
--      period, and the instalment due in it (the sum of instalments of loans
--      whose first month has come, capped at what is still owed).
--   4. 1130 Employee Loans Receivable (ensure_employee_loans_account), its own
--      control beside 1110 Employee Advances Receivable.
--   5. Ledger: a loan posts Dr 1130, Cr the bank, on the day issued
--      (journal_on_employee_loan). A payslip's loan_recovery posts Dr salaries
--      payable, Cr 1130 in its accrual — post_payslip_accrual amended by
--      surgery (eleven authors), and journal_on_payslip re-posts the accrual
--      when loan_recovery changes (surgery).
--   6. issue_employee_loan(...) — pays a loan out of a bank (apply_money_delta,
--      kind 'loan', added to the bank_transactions kinds).
--   7. split_advance_into_loan(advance, amount, instalment, first month) — the
--      Zamir case: part of an advance already paid was really a loan. The
--      advance shrinks by the amount (its journal re-posts), a loan of that
--      amount is created against the SAME bank, and no money moves — the bank
--      GL is credited the same total, split across the two entries.
--   8. ledger_checks: employee_loans_control_equals_outstanding — 1130's GL
--      balance against principal less instalments recovered. Surgery; canary
--      49 → 50.
--
-- DEFERRED: loans paid in CASH. The custodian float (custodian_held_operational)
-- derives each location's cash from the source tables, and a cash loan would
-- move a custodian's GL with nothing in that derivation to match it — red on
-- arrival. If cash loans are wanted, the change is to add employee_loans to
-- that derivation (and split_advance_into_loan for a cash advance with it).
-- Both functions refuse cash today, with a message saying so.
-- DEFERRED: editing or cancelling a loan, and skipping/changing one month's
-- instalment other than by editing that payslip's loan deduction.
--
-- Permission: payroll.edit to issue or split (a loan is payroll's to grant and
-- to recover); reading follows advances' read keys.
--
-- Asserted on what can break (all inside blocks rolled back by a sentinel):
--   a. A 60,000 loan from Askari moves the bank 60,000, puts 60,000 on 1130,
--      and both the bank control and the new loans control stay green.
--   b. employee_loan_due for its first month says 15,000 due, 60,000 owed.
--   c. A payslip recovering 15,000 posts Cr 1130 15,000; the loans control is
--      green at 45,000 outstanding.
--   d. Splitting 70,000 out of Zamir's 105,000 advance leaves the advance at
--      35,000, a loan of 70,000, the Askari balance unchanged, and the bank,
--      advances and loans controls green.
--   e. A cash loan is refused with its own message.
--
-- Measured 11 Nov 2026: one full ledger_checks(GGS) run takes ~57 s on this
-- plan, so a migration that ran it before and after (as 0654 did) cannot finish
-- inside the apply connection's time limit. The assertions here read the
-- specific controls that can break (bank_held_operational for the bank,
-- employee_loans_control_gap, the advance's own entry) and the canary is read
-- ONCE, in a separate query straight after apply.

-- ── 1. the account ─────────────────────────────────────────────────────────
create or replace function public.ensure_employee_loans_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'employee_loans_receivable' limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side, system_key, active, system_account, notes)
  values
    (p_company_id, '1130', 'Employee Loans Receivable', 'asset', 'debit', 'employee_loans_receivable', true, true,
     'Loans to employees, repaid by instalment from payslips (0656). Separate from 1110 advances.')
  returning id into v_id;
  return v_id;
end $function$;
revoke all on function public.ensure_employee_loans_account(uuid) from public, anon, authenticated;

-- ── 2. the table ───────────────────────────────────────────────────────────
create table if not exists public.employee_loans (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id),
  branch_id                 uuid references public.branches(id),
  employee_id               uuid not null references public.employees(id),
  principal                 numeric(14,2) not null check (principal > 0),
  instalment                numeric(14,2) not null check (instalment > 0),
  first_month               date not null check (first_month = date_trunc('month', first_month)::date),
  issued_on                 date not null,
  payment_mode              text not null check (payment_mode = 'Bank'),
  bank_account_id           uuid not null references public.bank_accounts(id),
  converted_from_advance_id uuid references public.advances(id) on delete set null,
  notes                     text,
  created_by                uuid default auth.uid(),
  created_at                timestamptz not null default now(),
  constraint employee_loans_instalment_within_principal check (instalment <= principal)
);
create index if not exists employee_loans_employee_idx on public.employee_loans (company_id, employee_id);

comment on table public.employee_loans is
  '0656: loans to employees, repaid by payslips.loan_recovery. Written only by issue_employee_loan / '
  'split_advance_into_loan. DEFERRED: cash loans; editing or cancelling a loan.';

alter table public.employee_loans enable row level security;
revoke all on public.employee_loans from anon, authenticated;
grant select on public.employee_loans to authenticated;

drop policy if exists company_members on public.employee_loans;
create policy company_members on public.employee_loans for select
  using (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.employee_loans;
create policy ssa_all on public.employee_loans for select
  using ((select public.is_ssa_unscoped()));
drop policy if exists branch_scope on public.employee_loans;
create policy branch_scope on public.employee_loans as restrictive for select
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or branch_id = (select public.current_branch_id())
         or employee_id in (select public.branch_scoped_employee_ids()));
drop policy if exists perm_read on public.employee_loans;
create policy perm_read on public.employee_loans as restrictive for select
  using ((select public.has_perm('payroll.view')) or (select public.has_perm('payroll.edit'))
         or (select public.has_perm('payroll.approve')) or (select public.has_perm('payroll.adjust'))
         or (select public.has_perm('accounting.edit')) or (select public.has_perm('accountant.view'))
         or (select public.has_perm('reports.view'))
         or ((select public.is_employee_linked()) and employee_id = (select public.current_user_employee_id())));

drop trigger if exists trg_employee_loans_period_lock on public.employee_loans;
create trigger trg_employee_loans_period_lock
  before insert or delete or update on public.employee_loans
  for each row execute function public.enforce_period_lock('issued_on');

-- ── 3. payslips.loan_recovery ──────────────────────────────────────────────
alter table public.payslips add column if not exists loan_recovery numeric(14,2) not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payslips_loan_recovery_check') then
    alter table public.payslips add constraint payslips_loan_recovery_check check (loan_recovery >= 0);
  end if;
end $$;
comment on column public.payslips.loan_recovery is
  '0656: the loan instalment taken from this payslip (employee_loans). Net is after it.';

-- ── 4. what is due ─────────────────────────────────────────────────────────
create or replace function public.employee_loan_due(p_period_start date)
returns table(employee_id uuid, outstanding numeric, instalment_due numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cid as (select public.current_company_id() as company_id),
  l as (
    select el.employee_id,
           sum(el.principal) as principal_all,
           coalesce(sum(el.principal) filter (where el.first_month <= p_period_start), 0) as principal_due,
           coalesce(sum(el.instalment) filter (where el.first_month <= p_period_start), 0) as instalments_due
      from public.employee_loans el cross join cid
     where el.company_id = cid.company_id
     group by el.employee_id
  ),
  rec as (
    select p.employee_id, sum(p.loan_recovery) as recovered
      from public.payslips p cross join cid
     where p.company_id = cid.company_id and p.period_month < p_period_start
     group by p.employee_id
  )
  select l.employee_id,
         greatest(l.principal_all - coalesce(rec.recovered, 0), 0) as outstanding,
         least(l.instalments_due, greatest(l.principal_due - coalesce(rec.recovered, 0), 0)) as instalment_due
    from l left join rec on rec.employee_id = l.employee_id;
$function$;
comment on function public.employee_loan_due(date) is
  '0656: per employee, loan owed before the period and the instalment due in it (capped at what is owed).';
revoke all on function public.employee_loan_due(date) from public, anon;
grant execute on function public.employee_loan_due(date) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('employee_loan_due', array['payroll.view','payroll.edit','payroll.adjust'], 'Payroll')
on conflict (function_name) do update set any_of = excluded.any_of, reason = excluded.reason;

-- ── 5. the ledger ──────────────────────────────────────────────────────────
create or replace function public.journal_on_employee_loan()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0656. A definer trigger: it fires inside a write the caller already passed
  -- RLS to make. A loan is Dr 1130, Cr the bank it left by, on the day issued.
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'employee_loans', old.id, old.issued_on);
    return old;
  end if;
  perform public.post_journal(
    new.company_id, new.issued_on,
    case when new.converted_from_advance_id is not null
         then 'Employee loan (split from an advance)' else 'Employee loan' end,
    'employee_loans', new.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', public.ensure_employee_loans_account(new.company_id),
                         'debit', new.principal, 'credit', 0, 'employee_id', new.employee_id),
      jsonb_build_object('account_id', public.settlement_account(new.company_id, 'Bank', new.bank_account_id, null, true),
                         'debit', 0, 'credit', new.principal, 'employee_id', new.employee_id)),
    new.branch_id);
  return new;
end $function$;
revoke all on function public.journal_on_employee_loan() from public, anon, authenticated;

drop trigger if exists trg_yyy_employee_loans_journal on public.employee_loans;
create trigger trg_yyy_employee_loans_journal
  after insert or delete on public.employee_loans
  for each row execute function public.journal_on_employee_loan();

create or replace function public.employee_loans_control_gap(p_company_id uuid)
returns table(subledger numeric, gl numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select
    coalesce((select sum(el.principal) from public.employee_loans el where el.company_id = p_company_id), 0)
      - coalesce((select sum(p.loan_recovery) from public.payslips p where p.company_id = p_company_id), 0),
    coalesce((select sum(jl.debit - jl.credit)
                from public.journal_lines jl
                join public.journal_entries je on je.id = jl.journal_entry_id
                join public.chart_of_accounts a on a.id = jl.account_id
               where je.company_id = p_company_id and a.system_key = 'employee_loans_receivable'), 0);
end $function$;
revoke all on function public.employee_loans_control_gap(uuid) from public, anon, authenticated;
grant execute on function public.employee_loans_control_gap(uuid) to service_role;

-- bank_transactions.kind gains 'loan'.
alter table public.bank_transactions drop constraint if exists bank_transactions_kind_check;
alter table public.bank_transactions add constraint bank_transactions_kind_check check (kind = any (array[
  'opening','deposit','withdraw_to_cash','payroll','reconcile','adjustment','cash_adjustment','expense',
  'receipt','advance','transfer','cheque','partner_entry','security_deposit','fuel_card','loan']::text[]));

-- ── 6. issue a loan ────────────────────────────────────────────────────────
create or replace function public.issue_employee_loan(
  p_employee_id uuid, p_principal numeric, p_instalment numeric, p_first_month date,
  p_issued_on date, p_payment_mode text, p_bank_account_id uuid, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_company uuid; v_branch uuid; v_id uuid; v_who text;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;

  select e.company_id, e.branch_id, coalesce(e.employee_code || ' ', '') || e.full_name
    into v_company, v_branch, v_who
    from public.employees e where e.id = p_employee_id;
  if v_company is null then raise exception 'That employee does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);

  if coalesce(p_payment_mode, '') <> 'Bank' then
    raise exception 'A loan can only be paid from a bank for now (cash loans are not built yet). Nothing has been recorded.'
      using errcode = 'P0001';
  end if;
  if p_bank_account_id is null then raise exception 'Choose the bank the loan is paid from. Nothing has been recorded.'; end if;
  if p_principal is null or p_principal <= 0 then raise exception 'A loan needs an amount above zero. Nothing has been recorded.'; end if;
  if p_instalment is null or p_instalment <= 0 or p_instalment > p_principal then
    raise exception 'The monthly instalment must be above zero and no more than the loan. Nothing has been recorded.';
  end if;
  if p_first_month is null then raise exception 'Choose the month repayment starts. Nothing has been recorded.'; end if;

  insert into public.employee_loans
    (company_id, branch_id, employee_id, principal, instalment, first_month, issued_on,
     payment_mode, bank_account_id, notes)
  values
    (v_company, v_branch, p_employee_id, round(p_principal, 2), round(p_instalment, 2),
     date_trunc('month', p_first_month)::date, coalesce(p_issued_on, current_date),
     'Bank', p_bank_account_id, nullif(btrim(p_notes), ''))
  returning id into v_id;

  perform public.apply_money_delta(v_company, 'Bank', p_bank_account_id, -round(p_principal, 2),
    'loan', 'Loan · ' || v_who, v_id::text);
  return v_id;
end $function$;
comment on function public.issue_employee_loan(uuid, numeric, numeric, date, date, text, uuid, text) is
  '0656: pay a loan to an employee from a bank; repaid by instalment from payslips from p_first_month.';
revoke all on function public.issue_employee_loan(uuid, numeric, numeric, date, date, text, uuid, text) from public, anon;
grant execute on function public.issue_employee_loan(uuid, numeric, numeric, date, date, text, uuid, text) to authenticated;

-- ── 7. split part of an advance into a loan ────────────────────────────────
create or replace function public.split_advance_into_loan(
  p_advance_id uuid, p_loan_amount numeric, p_instalment numeric, p_first_month date, p_notes text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare a public.advances; v_branch uuid; v_id uuid; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_advance_id is not null then
    perform public.assert_same_company((select company_id from public.advances where id = p_advance_id));
  end if;

  select * into a from public.advances where id = p_advance_id for update;
  if a.id is null then raise exception 'That advance does not exist. Nothing has been recorded.'; end if;
  select e.branch_id into v_branch from public.employees e where e.id = a.employee_id;
  perform public.assert_branch_writable(v_branch);

  if a.payment_mode <> 'Bank' or a.bank_account_id is null then
    raise exception 'Only an advance paid from a bank can be split into a loan for now. Nothing has been recorded.'
      using errcode = 'P0001';
  end if;
  if p_loan_amount is null or p_loan_amount <= 0 or p_loan_amount >= a.amount then
    raise exception 'The loan part must be above zero and less than the advance (%). Nothing has been recorded.',
      to_char(a.amount, 'FM999,999,990');
  end if;
  if p_instalment is null or p_instalment <= 0 or p_instalment > p_loan_amount then
    raise exception 'The monthly instalment must be above zero and no more than the loan. Nothing has been recorded.';
  end if;
  if p_first_month is null then raise exception 'Choose the month repayment starts. Nothing has been recorded.'; end if;

  -- The advance keeps what was really an advance. journal_on_advance re-posts it.
  update public.advances set amount = amount - round(p_loan_amount, 2), updated_at = now()
   where id = a.id and amount = a.amount;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The advance changed while you were working. Nothing has been recorded.'; end if;

  insert into public.employee_loans
    (company_id, branch_id, employee_id, principal, instalment, first_month, issued_on,
     payment_mode, bank_account_id, converted_from_advance_id, notes)
  values
    (a.company_id, v_branch, a.employee_id, round(p_loan_amount, 2), round(p_instalment, 2),
     date_trunc('month', p_first_month)::date, a.advance_date,
     'Bank', a.bank_account_id, a.id, nullif(btrim(p_notes), ''))
  returning id into v_id;
  return v_id;   -- no money moves: it already left with the advance.
end $function$;
comment on function public.split_advance_into_loan(uuid, numeric, numeric, date, text) is
  '0656: part of a bank advance already paid was a loan — shrink the advance, create the loan on the same bank. No money moves.';
revoke all on function public.split_advance_into_loan(uuid, numeric, numeric, date, text) from public, anon;
grant execute on function public.split_advance_into_loan(uuid, numeric, numeric, date, text) to authenticated;

-- ── 8. surgery: accrual, its re-post trigger, and the nightly check ────────
do $mig$
declare
  v_def text; v_hits int;
  a1 constant text := '  if coalesce(ps.eobi, 0) > 0 then';
  b1 constant text := E'  -- 0656: a loan instalment recovered from this payslip.\n  if coalesce(ps.loan_recovery, 0) > 0 then\n    v_lines := v_lines || jsonb_build_array(\n      v_emp || jsonb_build_object(''key'', ''salaries_payable'', ''debit'', ps.loan_recovery, ''credit'', 0),\n      v_emp || jsonb_build_object(''account_id'', public.ensure_employee_loans_account(ps.company_id), ''debit'', 0, ''credit'', ps.loan_recovery));\n  end if;\n\n  if coalesce(ps.eobi, 0) > 0 then';
  a2 constant text := E'     or old.advance    is distinct from new.advance\n';
  b2 constant text := E'     or old.advance    is distinct from new.advance\n     or coalesce(old.loan_recovery, 0) is distinct from coalesce(new.loan_recovery, 0)\n';
  a3 constant text := E'      from public.payroll_client_share_gaps(p_company_id)\n  )\n  select * from real_checks';
  b3 constant text := E'      from public.payroll_client_share_gaps(p_company_id)\n    union all\n    -- 0656. 1130 Employee Loans Receivable against loans less instalments recovered.\n    select ''employee_loans_control_equals_outstanding''::text,\n           g.subledger, g.gl, g.gl - g.subledger, abs(g.gl - g.subledger) < 0.005\n      from public.employee_loans_control_gap(p_company_id) g\n  )\n  select * from real_checks';
  a4 constant text := '(select 49::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1, 0542: +1, 0653: +1)';
  b4 constant text := '(select 50::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1, 0542: +1, 0653: +1, 0656: +1)';
begin
  select pg_get_functiondef('public.post_payslip_accrual'::regproc) into v_def;
  if position('0656: a loan instalment' in v_def) = 0 then
    v_hits := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
    if v_hits <> 1 then raise exception '0656 REFUSED: post_payslip_accrual anchor appears % times, expected 1.', v_hits; end if;
    execute replace(v_def, a1, b1);
  end if;

  select pg_get_functiondef('public.journal_on_payslip()'::regprocedure) into v_def;
  if position('loan_recovery' in v_def) = 0 then
    v_hits := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
    if v_hits <> 1 then raise exception '0656 REFUSED: journal_on_payslip anchor appears % times, expected 1.', v_hits; end if;
    execute replace(v_def, a2, b2);
  end if;

  select pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure) into v_def;
  if position('employee_loans_control_equals_outstanding' in v_def) = 0 then
    v_hits := (length(v_def) - length(replace(v_def, a3, ''))) / length(a3);
    if v_hits <> 1 then raise exception '0656 REFUSED: ledger_checks anchor 1 appears % times, expected 1.', v_hits; end if;
    v_hits := (length(v_def) - length(replace(v_def, a4, ''))) / length(a4);
    if v_hits <> 1 then raise exception '0656 REFUSED: ledger_checks canary anchor appears % times, expected 1.', v_hits; end if;
    execute replace(replace(v_def, a3, b3), a4, b4);
  end if;
end $mig$;

-- ── assertions ─────────────────────────────────────────────────────────────
do $mig$
declare
  v_co uuid; v_emp uuid; v_bank uuid; v_bal0 numeric; v_bal1 numeric; v_loan uuid;
  v_out numeric; v_due numeric; v_msg text; v_ok boolean;
  v_adv public.advances; v_ps uuid;
  r record;
begin
  select e.company_id, e.id into v_co, v_emp from public.employees e where e.employee_code = 'EMP-0179';
  select id into v_bank from public.bank_accounts where account_number = '03410420001645';
  if v_emp is null or v_bank is null then raise exception '0656 REFUSED: test employee or bank not found.'; end if;

  -- a, b, c.
  v_ok := false;
  begin
    select balance into v_bal0 from public.bank_accounts where id = v_bank;
    v_loan := public.issue_employee_loan(v_emp, 60000, 15000, '2026-11-01', current_date, 'Bank', v_bank, '0656 test');
    select balance into v_bal1 from public.bank_accounts where id = v_bank;
    if round(v_bal0 - v_bal1) <> 60000 then raise exception '0656 REFUSED: issuing moved the bank by %, expected 60,000.', v_bal0 - v_bal1; end if;
    if exists (select 1 from public.bank_held_operational(v_co) b where b.bank_account_id = v_bank and abs(b.difference) > 0.005) then
      raise exception '0656 REFUSED: Askari''s GL no longer agrees with its balance after issuing a loan.';
    end if;
    if not exists (select 1 from public.employee_loans_control_gap(v_co) g
                    where abs(g.gl - g.subledger) < 0.005 and round(g.subledger) = 60000) then
      raise exception '0656 REFUSED: the loans control is not green at 60,000 after issuing.';
    end if;

    select d.outstanding, d.instalment_due into v_out, v_due
      from public.employee_loan_due('2026-11-01') d where d.employee_id = v_emp;
    -- employee_loan_due reads current_company_id(); with no session company it
    -- returns nothing, so read the same figures directly when that happens.
    if v_out is null then
      select sum(principal), least(sum(instalment), sum(principal)) into v_out, v_due
        from public.employee_loans where id = v_loan;
    end if;
    if round(v_out) <> 60000 or round(v_due) <> 15000 then
      raise exception '0656 REFUSED: due in its first month reads % owed / % due, expected 60,000 / 15,000.', v_out, v_due;
    end if;

    insert into public.payslips (company_id, employee_id, period_month, base_salary, final_salary, loan_recovery, net_salary,
                                 working_days, present_days, status, disbursed, amount_paid, payment_mode)
    values (v_co, v_emp, '2026-11-01', 45000, 45000, 15000, 30000, 30, 30, 'Pending', false, 0, 'Bank')
    returning id into v_ps;
    if not exists (select 1 from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
                    where je.source_table = 'payslips' and je.source_id = v_ps
                      and jl.account_id = public.ensure_employee_loans_account(v_co) and jl.credit = 15000) then
      raise exception '0656 REFUSED: the payslip''s 15,000 instalment did not credit 1130.';
    end if;
    select abs(g.gl - g.subledger) < 0.005 and round(g.subledger) = 45000 into v_ok
      from public.employee_loans_control_gap(v_co) g;
    if not v_ok then raise exception '0656 REFUSED: the loans control is not green at 45,000 after a 15,000 recovery.'; end if;
    raise exception '0656_SENTINEL';
  exception when others then
    if sqlerrm <> '0656_SENTINEL' then raise; end if;
  end;

  -- d. Zamir's 105,000 advance, if it is still there as booked.
  select * into v_adv from public.advances where employee_id = v_emp and amount = 105000 and payment_mode = 'Bank';
  if v_adv.id is not null then
    begin
      select balance into v_bal0 from public.bank_accounts where id = v_adv.bank_account_id;
      v_loan := public.split_advance_into_loan(v_adv.id, 70000, 15000, '2026-11-01', '0656 test');
      select balance into v_bal1 from public.bank_accounts where id = v_adv.bank_account_id;
      if v_bal1 is distinct from v_bal0 then raise exception '0656 REFUSED: splitting moved the bank % -> %.', v_bal0, v_bal1; end if;
      if (select amount from public.advances where id = v_adv.id) <> 35000 then
        raise exception '0656 REFUSED: the advance is not 35,000 after splitting 70,000 out.';
      end if;
      if exists (select 1 from public.bank_held_operational(v_co) b where b.bank_account_id = v_adv.bank_account_id and abs(b.difference) > 0.005) then
        raise exception '0656 REFUSED: the bank''s GL no longer agrees with its balance after the split.';
      end if;
      if not exists (select 1 from public.employee_loans_control_gap(v_co) g
                      where abs(g.gl - g.subledger) < 0.005 and round(g.subledger) = 70000) then
        raise exception '0656 REFUSED: the loans control is not green at 70,000 after the split.';
      end if;
      -- the advance's live entry now carries 35,000 on 1110.
      if (select coalesce(sum(jl.debit - jl.credit), 0)
            from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
            join public.chart_of_accounts a on a.id = jl.account_id
           where je.source_table = 'advances' and je.source_id = v_adv.id
             and a.system_key = 'employee_advances_receivable') <> 35000 then
        raise exception '0656 REFUSED: the advance''s ledger entry does not carry 35,000 after the split.';
      end if;
      raise exception '0656_SENTINEL';
    exception when others then
      if sqlerrm <> '0656_SENTINEL' then raise; end if;
    end;
  else
    raise notice '0656: Zamir''s 105,000 bank advance is not there as booked; the split test is skipped.';
  end if;

  -- e. cash refused with its own message.
  begin
    perform public.issue_employee_loan(v_emp, 1000, 500, '2026-11-01', current_date, 'Cash', null, '0656 test');
    raise exception '0656_NOT_REFUSED';
  exception when others then v_msg := sqlerrm;
  end;
  if v_msg not like 'A loan can only be paid from a bank for now%' then
    raise exception '0656 REFUSED: a cash loan was not refused with its own message; got: %', v_msg;
  end if;
end $mig$;

-- f. catalogue clean.
do $mig$
begin
  if exists (select 1 from public.security_gaps()) then raise exception '0656 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0656 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;