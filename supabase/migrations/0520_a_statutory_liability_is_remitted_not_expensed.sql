-- 0520 — A statutory liability is remitted against itself, not expensed: one
-- action to pay it, a refusal that keeps statutory payments off Prepaid, and a
-- check that goes red when one is booked as cost while its liability is owed.
--
-- NUMBER: written as 0520 on 2026-10-17 (first drafted as 0519; renumbered unapplied so the cutover date setting, which this reads, comes first). Claim it against
-- supabase_migrations.schema_migrations at apply time — another session applies
-- to this database too. If 0520 is taken, rename the FILE; never edit this text.
--
-- ===========================================================================
-- THE HOLE
-- ===========================================================================
-- Nothing in the system could remit a statutory liability. Payroll credits EOBI
-- Payable (2300) with the employee's EOBI and Salary Tax Payable (2450) with the
-- tax it withholds; nothing anywhere debited either, except payslip reversals.
-- The expense screen was the only way to record paying them, and every path
-- out of it lands on cost: map_expense_to_coa_key sends EOBI/IESSI/PESSI to
-- 5100 Guard Statutory and Taxes to 7000 Income Tax, and its "which months does
-- this cost belong to?" choice, offered for every category, routes any period
-- to 1160 Prepaid Expenses. So 2300 and 2450 could never clear, and every
-- remittance counted the employee's share as cost a second time.
--
-- Measured 2026-10-17 (GGS): nine statutory payments, 898,289, none against a
-- liability. EOBI 266,500 (14 Sep) to 5100 and 244,200 (2 Oct) to 1160; FBR
-- 41,923 (15 Sep) to 7000 and 27,013 (15 Oct) to 1160; PRA 15,346 to 7000;
-- PESSI 60,000 + 132,000 + 60,025 and IESSI 51,282 to 5100. SHAYAN_A: IESSI
-- 50,000 to 5100. NONE IS CONVERTED HERE — the EOBI, FBR and PRA corrections
-- wait on challans the user is supplying.
--
-- ===========================================================================
-- WHAT THIS ADDS
-- ===========================================================================
-- a. 2350 Statutory Contributions Payable (PESSI/IESSI), per company, by
--    ensure_statutory_contributions_account() — the ensure_prepaid_expenses_
--    account pattern. 2300 stays EOBI only. Nothing credits 2350 yet: payroll
--    accrues no PESSI/IESSI, and the cutover's pre-cutover carry (the
--    PESSI Taxila July–August 132,000) is a later migration.
--
-- b. statutory_remittances, written ONLY by remit_statutory_liability(): pick
--    the scheme and the period, see what payroll accrued for it
--    (statutory_liability_due), and post:
--      Dr the liability (2300 / 2450 / 2350)  up to what is still due for the period
--      Dr 5100 Guard Statutory                the remainder, if the scheme has one
--      Cr the bank or custodian cash account  the whole amount
--    and the money out through apply_money_delta — the same shape as
--    pay_vendor_payables. Salary tax has NO remainder: an FBR challan larger
--    than the tax withheld for the month contains something that is not salary
--    tax, and the action refuses rather than guessing what. EOBI's remainder is
--    the employer share, which payroll does not accrue yet (eobi_employer is
--    zero on every payslip; accruing it is DECIDED and waits on the rate).
--    Permission: accounting.edit, the key pay_vendor_payables asks — paying a
--    liability out of a bank is that act, not an expense write.
--
-- c. ENFORCEMENT A — a statutory category (EOBI, IESSI, PESSI, Taxes) cannot
--    carry a coverage or service period. Refused in the database, so no screen
--    can reintroduce it. It fires only when the period or the category is SET OR
--    CHANGED, so the two existing rows that already carry one (244,200 and
--    27,013, awaiting conversion) can still have their notes edited.
--
-- d. ENFORCEMENT B — no_statutory_remittance_booked_as_cost: every expense in a
--    statutory category dated when its scheme's liability held a credit balance.
--    THIS IS THE ONE THAT MATTERS: the action is the right road; this is what
--    stops the old one still being used, from any screen including mobile.
--    Expected red at apply: 5 at GGS (both EOBI, both FBR, PRA — PRA is booked
--    in "Taxes", the salary-tax category, while 2450 holds a balance), 0 at
--    SHAYAN_A. PESSI and IESSI are green: 2350 holds nothing, so booking them as
--    employer cost is not double counting anything.
--
-- A MONTH ON OR BEFORE THE CUTOVER (0519). A payment for such a month sends its
-- unaccrued remainder to 3200 Opening Balance Equity, not to 5100: that cost
-- belongs to a month the GL no longer itemises, so it is a prior-period
-- adjustment of the opening, never a charge in the month it happened to be
-- paid. The two known cases are the August employer EOBI (193,210 of the 14 Sep
-- payment) and PESSI Taxila July–August (132,000, paid 5 Oct). Needs 0519.
--
-- statutory_category_scheme() is the ONE place the four category names map to a
-- scheme; A, B and the screen all read it. The screen also mirrors the list
-- (HARDCODED_EXPENSE_CATEGORIES already carries the names).
--
-- Canary 45 -> 46.

-- ---------------------------------------------------------------------------
-- 0. BEFORE.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.ledger_cutover_date(uuid)') is null then
    raise exception '0520 REFUSED: ledger_cutover_date() does not exist. Apply 0519 (the cutover date setting) first.';
  end if;
end $$;

create temp table t0520_red on commit drop as
select c.id co, c.name, lc.check_name, lc.actual, lc.passed
  from public.companies c, public.ledger_checks(c.id) lc;

-- ---------------------------------------------------------------------------
-- 1. The scheme map — one definition.
-- ---------------------------------------------------------------------------
create or replace function public.statutory_category_scheme(p_cat_name text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case p_cat_name
    when 'EOBI'  then 'eobi'
    when 'PESSI' then 'pessi'
    when 'IESSI' then 'iessi'
    when 'Taxes' then 'salary_tax'
  end;
$function$;

create or replace function public.statutory_liability_key(p_scheme text)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case p_scheme
    when 'eobi'       then 'eobi_payable'
    when 'salary_tax' then 'salary_tax_payable'
    when 'pessi'      then 'statutory_contributions_payable'
    when 'iessi'      then 'statutory_contributions_payable'
  end;
$function$;

grant execute on function public.statutory_category_scheme(text), public.statutory_liability_key(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. a. The account.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_statutory_contributions_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_id uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'statutory_contributions_payable'
   limit 1;
  if v_id is not null then return v_id; end if;

  if exists (select 1 from public.chart_of_accounts where company_id = p_company_id and account_code = '2350') then
    raise exception 'Account code 2350 is already used in this company by something else. Nothing has been created.'
      using errcode = '23505';
  end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account, is_control)
  values
    (p_company_id, '2350', 'Statutory Contributions Payable (PESSI/IESSI)', 'liability', 'credit',
     'statutory_contributions_payable', true, true, false)
  returning id into v_id;
  return v_id;
end;
$function$;

revoke execute on function public.ensure_statutory_contributions_account(uuid) from public, anon;
grant execute on function public.ensure_statutory_contributions_account(uuid) to authenticated, service_role;

do $$
declare r record;
begin
  for r in select id from public.companies loop
    perform public.ensure_statutory_contributions_account(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. b. The record, what is due, and the action.
-- ---------------------------------------------------------------------------
create table if not exists public.statutory_remittances (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id),
  branch_id             uuid references public.branches(id),
  scheme                text not null check (scheme in ('eobi', 'salary_tax', 'pessi', 'iessi')),
  period_month          date not null check (period_month = date_trunc('month', period_month)::date),
  amount                numeric(14,2) not null check (amount > 0),
  liability_portion     numeric(14,2) not null check (liability_portion >= 0),
  cost_portion          numeric(14,2) not null check (cost_portion >= 0),
  paid_on               date not null,
  paid_via              text not null check (paid_via in ('Cash', 'Bank')),
  bank_account_id       uuid references public.bank_accounts(id),
  custodian_location_id uuid references public.cash_locations(id),
  reference             text,
  notes                 text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  check (liability_portion + cost_portion = amount),
  check ((paid_via = 'Bank') = (bank_account_id is not null)),
  check ((paid_via = 'Cash') = (custodian_location_id is not null))
);
create index if not exists statutory_remittances_period on public.statutory_remittances (company_id, scheme, period_month);

alter table public.statutory_remittances enable row level security;
drop policy if exists company_members_read on public.statutory_remittances;
create policy company_members_read on public.statutory_remittances
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.statutory_remittances;
create policy ssa_read on public.statutory_remittances
  for select using ((select public.is_ssa_unscoped()));

drop trigger if exists trg_company_not_archived on public.statutory_remittances;
create trigger trg_company_not_archived before insert or update on public.statutory_remittances
  for each row execute function public.enforce_company_not_archived();
drop trigger if exists trg_statutory_remittances_period_lock on public.statutory_remittances;
create trigger trg_statutory_remittances_period_lock before insert or update or delete on public.statutory_remittances
  for each row execute function public.enforce_period_lock('paid_on');
drop trigger if exists trg_zzz_statutory_remittances_audit on public.statutory_remittances;
create trigger trg_zzz_statutory_remittances_audit after insert or update or delete on public.statutory_remittances
  for each row execute function public.log_audit_change();

comment on table public.statutory_remittances is
  '0520. A payment of a statutory liability (EOBI, salary tax, PESSI, IESSI) for a period. Written only by remit_statutory_liability(); no user writes this table directly. Reversal is not built yet.';

-- What payroll accrued for a scheme and period. ONE definition; the cutover's
-- pre-cutover carry is expected to extend it.
create or replace function public.statutory_accrued(p_company_id uuid, p_scheme text, p_period date)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return case p_scheme
    when 'eobi' then (select coalesce(sum(coalesce(ps.eobi, 0) + coalesce(ps.eobi_employer, 0)), 0)
                        from public.payslips ps
                       where ps.company_id = p_company_id and ps.period_month = date_trunc('month', p_period)::date)
    when 'salary_tax' then (select coalesce(sum(coalesce(ps.income_tax, 0)), 0)
                              from public.payslips ps
                             where ps.company_id = p_company_id and ps.period_month = date_trunc('month', p_period)::date)
    else 0::numeric   -- PESSI / IESSI: payroll accrues neither
  end;
end;
$function$;

create or replace function public.statutory_liability_due(p_company_id uuid, p_scheme text, p_period date)
returns table(scheme text, period_month date, accrued numeric, remitted numeric, due numeric,
              liability_account text, liability_balance numeric, remainder_goes_to text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_m date := date_trunc('month', p_period)::date; v_acc numeric; v_rem numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if public.statutory_liability_key(p_scheme) is null then
    raise exception 'Unknown statutory scheme %.', p_scheme using errcode = '22023';
  end if;
  v_acc := public.statutory_accrued(p_company_id, p_scheme, v_m);
  select coalesce(sum(r.liability_portion), 0) into v_rem
    from public.statutory_remittances r
   where r.company_id = p_company_id and r.scheme = p_scheme and r.period_month = v_m;
  return query
  select p_scheme, v_m, v_acc, v_rem, greatest(v_acc - v_rem, 0),
         a.account_code || ' ' || a.account_name,
         coalesce((select sum(jl.credit - jl.debit) from public.journal_lines jl where jl.account_id = a.id), 0),
         case when p_scheme = 'salary_tax' then 'refused — a challan larger than the tax withheld contains something else'
              when public.ledger_cutover_date(p_company_id) is not null
               and v_m <= date_trunc('month', public.ledger_cutover_date(p_company_id))::date
                then '3200 Opening Balance Equity (a month on or before the cutover)'
              else '5100 Guard Statutory (employer share)' end
    from public.chart_of_accounts a
   where a.company_id = p_company_id and a.system_key = public.statutory_liability_key(p_scheme);
end;
$function$;

create or replace function public.remit_statutory_liability(
  p_company_id            uuid,
  p_scheme                text,
  p_period                date,
  p_amount                numeric,
  p_paid_via              text,
  p_bank_account_id       uuid default null,
  p_custodian_location_id uuid default null,
  p_paid_on               date default null,
  p_reference             text default null,
  p_notes                 text default null,
  p_branch_id             uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_m       date := date_trunc('month', p_period)::date;
  v_paid_on date := coalesce(p_paid_on, current_date);
  v_branch  uuid;
  v_due     numeric;
  v_liab    numeric;
  v_cost    numeric;
  v_key     text := public.statutory_liability_key(p_scheme);
  v_label   text;
  v_row     public.statutory_remittances%rowtype;
  v_lines   jsonb := '[]'::jsonb;
  v_cost_key text := 'cos_statutory';
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;

  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company of p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  -- tenant guard [resolved]: owning company of p_custodian_location_id via public.cash_locations
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;
  -- tenant guard [resolved]: owning company of p_branch_id via public.branches
  if p_branch_id is not null then perform public.assert_same_company((select company_id from public.branches where id = p_branch_id)); end if;

  if v_key is null then
    raise exception 'Choose EOBI, salary tax, PESSI or IESSI. Nothing has been recorded.' using errcode = '22023';
  end if;
  if p_period is null then
    raise exception 'Say which month this payment is for. Nothing has been recorded.' using errcode = '22023';
  end if;
  p_amount := round(coalesce(p_amount, 0), 2);
  if p_amount <= 0 then
    raise exception 'Enter an amount greater than zero. Nothing has been recorded.' using errcode = '23514';
  end if;
  if v_paid_on > current_date then
    raise exception 'A remittance cannot be dated in the future. Nothing has been recorded.' using errcode = '23514';
  end if;
  if p_paid_via not in ('Cash', 'Bank') then
    raise exception 'A statutory liability is paid in Cash or Bank, not %. Nothing has been recorded.', coalesce(p_paid_via, '—') using errcode = 'P0001';
  end if;
  if p_paid_via = 'Bank' and p_bank_account_id is null then
    raise exception 'Paying by bank needs a bank account. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_paid_via = 'Cash' and p_custodian_location_id is null then
    raise exception 'Paying in cash needs the office-staff member who paid it. Nothing has been recorded.' using errcode = 'P0001';
  end if;

  v_branch := coalesce(p_branch_id, public.head_office_region(p_company_id));
  perform public.assert_branch_writable(v_branch);
  if p_scheme in ('pessi', 'iessi') then perform public.ensure_statutory_contributions_account(p_company_id); end if;

  -- Serialise remittances for the same scheme and period so two cannot both
  -- take the same "due".
  perform pg_advisory_xact_lock(hashtext('statutory_remit:' || p_company_id::text || ':' || p_scheme || ':' || v_m::text));

  select d.due into v_due from public.statutory_liability_due(p_company_id, p_scheme, v_m) d;
  v_liab := least(p_amount, coalesce(v_due, 0));
  v_cost := p_amount - v_liab;

  v_label := case p_scheme when 'eobi' then 'EOBI' when 'salary_tax' then 'Salary tax (FBR)'
                           when 'pessi' then 'PESSI' else 'IESSI' end;

  if p_scheme = 'salary_tax' and v_cost > 0 then
    raise exception 'Only % of salary tax is owed for % (withheld by payroll, less what has been remitted). This payment is %. The rest is not salary tax — record it as what it is. Nothing has been recorded.',
      to_char(coalesce(v_due, 0), 'FM999,999,999,990.00'), to_char(v_m, 'FMMonth YYYY'), to_char(p_amount, 'FM999,999,999,990.00')
      using errcode = '23514';
  end if;

  insert into public.statutory_remittances
    (company_id, branch_id, scheme, period_month, amount, liability_portion, cost_portion,
     paid_on, paid_via, bank_account_id, custodian_location_id, reference, notes, created_by)
  values
    (p_company_id, v_branch, p_scheme, v_m, p_amount, v_liab, v_cost,
     v_paid_on, p_paid_via,
     case when p_paid_via = 'Bank' then p_bank_account_id end,
     case when p_paid_via = 'Cash' then p_custodian_location_id end,
     nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_row;

  if v_liab > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('key', v_key, 'debit', v_liab, 'credit', 0));
  end if;
  if v_cost > 0 then
    -- A month on or before the cutover: the remainder adjusts the opening (0519).
    v_cost_key := case when public.ledger_cutover_date(p_company_id) is not null
                        and v_m <= date_trunc('month', public.ledger_cutover_date(p_company_id))::date
                       then 'opening_balance_equity' else 'cos_statutory' end;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('key', v_cost_key, 'debit', v_cost, 'credit', 0));
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'account_id', public.settlement_account(p_company_id, p_paid_via, v_row.bank_account_id, v_row.custodian_location_id, true),
    'debit', 0, 'credit', p_amount));

  perform public.post_journal(
    p_company_id, v_paid_on,
    v_label || ' remitted for ' || to_char(v_m, 'FMMonth YYYY') || coalesce(' · ' || v_row.reference, ''),
    'statutory_remittances', v_row.id, false, v_lines, v_branch);

  perform public.apply_money_delta(
    p_company_id, p_paid_via, v_row.bank_account_id, -p_amount,
    'expense', v_label || ' remitted for ' || to_char(v_m, 'FMMonth YYYY'), v_row.id::text);

  return jsonb_build_object('remittance_id', v_row.id, 'scheme', p_scheme, 'period', v_m,
                            'amount', p_amount, 'against_liability', v_liab, 'to_cost', v_cost,
                            'cost_account', case when v_cost > 0 then v_cost_key end);
end;
$function$;

revoke execute on function public.statutory_accrued(uuid, text, date), public.statutory_liability_due(uuid, text, date),
  public.remit_statutory_liability(uuid, text, date, numeric, text, uuid, uuid, date, text, text, uuid) from public, anon;
grant execute on function public.statutory_accrued(uuid, text, date), public.statutory_liability_due(uuid, text, date),
  public.remit_statutory_liability(uuid, text, date, numeric, text, uuid, uuid, date, text, text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. c. ENFORCEMENT A — no period on a statutory category.
-- ---------------------------------------------------------------------------
create or replace function public.refuse_statutory_period()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare v_scheme text;
begin
  if new.coverage_start is null and new.service_start is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.category_id    is not distinct from new.category_id
     and old.coverage_start is not distinct from new.coverage_start
     and old.coverage_end   is not distinct from new.coverage_end
     and old.service_start  is not distinct from new.service_start
     and old.service_end    is not distinct from new.service_end then
    return new;   -- 0520: rows already carrying a period stay editable until converted
  end if;
  select public.statutory_category_scheme(c.name) into v_scheme
    from public.expense_categories c where c.id = new.category_id;
  if v_scheme is not null then
    raise exception 'A statutory payment (EOBI, IESSI, PESSI, Taxes) cannot be spread over a coverage or service period — it pays a liability, it is not a cost waiting to be used. Record it with "Pay a statutory liability". Nothing has been recorded.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_ccc_expense_statutory_no_period on public.expenses;
create trigger trg_ccc_expense_statutory_no_period
  before insert or update on public.expenses
  for each row execute function public.refuse_statutory_period();

-- ---------------------------------------------------------------------------
-- 5. d. ENFORCEMENT B — the check.
-- ---------------------------------------------------------------------------
create or replace function public.statutory_booked_as_cost(p_company_id uuid)
returns table(expense_id uuid, expense_date date, description text, category text, scheme text,
              amount numeric, liability_account text, liability_balance_then numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0520. A remittance booked as an EXPENSE while the liability it pays held a
  -- credit balance on that date: the liability never clears and the cost is
  -- counted twice. Any screen, any path — this reads the expense row.
  return query
  select x.id, x.expense_date, x.description, c.name::text, s.scheme, x.amount,
         a.account_code || ' ' || a.account_name,
         bal.b
    from public.expenses x
    join public.expense_categories c on c.id = x.category_id
    cross join lateral (select public.statutory_category_scheme(c.name) scheme) s
    join public.chart_of_accounts a
      on a.company_id = x.company_id and a.system_key = public.statutory_liability_key(s.scheme)
    cross join lateral (
      select coalesce(sum(jl.credit - jl.debit), 0) b
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
       where jl.account_id = a.id and je.entry_date <= x.expense_date) bal
   where x.company_id = p_company_id
     and s.scheme is not null
     and bal.b > 0.005
   order by x.expense_date, x.description;
end;
$function$;

revoke execute on function public.statutory_booked_as_cost(uuid) from public, anon;
grant execute on function public.statutory_booked_as_cost(uuid) to authenticated, service_role;

create or replace function pg_temp.surg0520(p_fn text, p_key text, p_old text, p_new text, p_marker text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_marker in v_def) > 0 then
    raise notice '0520: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0520 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

do $$
declare v_before int; v_after int; v_co uuid;
begin
  if position('no_statutory_remittance_booked_as_cost' in pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure)) > 0 then
    raise notice '0520: ledger_checks already carries no_statutory_remittance_booked_as_cost.';
    return;
  end if;
  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_before from public.ledger_checks(v_co);

  perform pg_temp.surg0520($f$public.ledger_checks(uuid)$f$, $k$lc_arm$k$,
    $a$    select 'no_definer_function_crosses_a_branch'::text,$a$,
    $b$    -- 0520. A statutory remittance booked as cost while its liability is
    -- owed. The action is the right road; this stops the old one being used.
    select 'no_statutory_remittance_booked_as_cost'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.statutory_booked_as_cost(p_company_id)
    union all
    select 'no_definer_function_crosses_a_branch'::text,$b$,
    $m$'no_statutory_remittance_booked_as_cost'$m$);

  perform pg_temp.surg0520($f$public.ledger_checks(uuid)$f$, $k$lc_canary$k$,
    $a$    from (select 45::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1)$a$,
    $b$    from (select 46::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1, 0520: +1)$b$,
    $m$(select 46::numeric n) e (n);$m$);

  select count(*) into v_after from public.ledger_checks(v_co);
  if v_after <> v_before + 1 then
    raise exception '0520 FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare v_bad int; v_txt text; v_n int;
begin
  -- 6a. Every company has 2350, and it is a liability with nothing on it.
  if exists (select 1 from public.companies c
              where not exists (select 1 from public.chart_of_accounts a
                                 where a.company_id = c.id and a.system_key = 'statutory_contributions_payable'
                                   and a.account_code = '2350' and a.account_type = 'liability')) then
    raise exception '0520 FAILED: a company has no 2350 Statutory Contributions Payable.';
  end if;

  -- 6b. The check sees the misbookings it was written for. Each of these five
  --     was booked in a statutory category while its liability held a balance.
  select count(*) into v_n
    from public.companies c, public.statutory_booked_as_cost(c.id) s
   where s.description in ('Eobi 109 guards', 'Eobi paid for 100 guards', 'FBR Taxes', 'FBR Tax paid', 'PRA Tax paid');
  if v_n < 5 then
    raise exception '0520 FAILED: the check found % of the five known misbooked remittances, expected all five.', v_n;
  end if;

  -- 6c. PESSI and IESSI are not flagged: 2350 holds nothing, so employer-only
  --     cost booked as cost double counts nothing.
  if exists (select 1 from public.companies c, public.statutory_booked_as_cost(c.id) s where s.scheme in ('pessi', 'iessi')) then
    raise exception '0520 FAILED: the check flags PESSI/IESSI while 2350 is empty.';
  end if;

  -- 6d. The red set, diffed. Allowed: the new check, the canary, and the gross
  --     trial-balance figure. Nothing is posted here, so even that should hold.
  select count(*), string_agg(a.name || ' ' || a.check_name || ' ' || coalesce(o.actual::text, 'new') || '->' || a.actual::text, '; ')
    into v_bad, v_txt
    from (select c.id co, c.name, lc.check_name, lc.actual, lc.passed
            from public.companies c, public.ledger_checks(c.id) lc) a
    left join t0520_red o on o.co = a.co and o.check_name = a.check_name
   where a.check_name not in ('no_statutory_remittance_booked_as_cost', 'checks_evaluated')
     and (o.check_name is null or o.passed is distinct from a.passed or o.actual is distinct from a.actual);
  if v_bad > 0 then raise exception '0520 FAILED: an unrelated check moved: %', v_txt; end if;

  if exists (select 1 from public.companies c, public.ledger_checks(c.id) lc
              where lc.check_name = 'checks_evaluated' and not lc.passed) then
    raise exception '0520 FAILED: checks_evaluated disagrees with the number of checks.';
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0520 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
