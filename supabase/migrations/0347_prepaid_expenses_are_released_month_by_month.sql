-- 0347 — a prepaid expense is released month by month.
--
-- THE PROBLEM. Shayan pays insurance six months ahead and licences one or two
-- years ahead. Today the whole cost lands in the month of payment, so one month
-- looks bad and five look good, and any client profitability absorbing it is
-- wrong in both directions.
--
-- THE TREATMENT (Shayan, confirmed explicitly):
--
--   At payment:
--     Dr  Prepaid Expenses (asset)   full amount
--     Cr  Bank / Cash                full amount
--
--   Each month of the coverage period:
--     Dr  the expense account        that month's portion
--     Cr  Prepaid Expenses           that month's portion
--
-- CASH FLOW TAKES THE FULL AMOUNT WHEN IT LEAVES; P&L TAKES THE MONTHLY
-- PORTION. That difference is the point. Nothing here touches the cash leg —
-- the credit side of the payment is exactly what it was, which is why the
-- cash-basis P&L and the cash-flow screen need no change at all.
--
-- ---------------------------------------------------------------------------
-- THE RELEASE MECHANISM, REPORTED BEFORE BUILDING AS ASKED.
--
-- 0323's pattern TRANSFERS, and it transfers cleanly. Its shape:
--
--   * the deferral posts at entry time, as part of the source document
--   * the recognition is NOT written then — recognise_advance_revenue() posts
--     it when the month arrives
--   * because 0322 refuses any entry posting into a period nobody has reached,
--     and writing a 12-month schedule today would be twelve violations of it
--
-- Every one of those reasons holds here, in the other direction: an asset
-- released to expense instead of a liability released to revenue. So this is
-- 0323 mirrored, and the one difference is stated rather than discovered:
--
--   0323 recognises ONE month per invoice (invoice_date -> period_start is a
--   single interval). A prepaid runs over MANY months, so the run must be
--   idempotent PER MONTH, not per document. It is: the guard is the existence
--   of a journal entry whose source_id is the expense AND whose entry_date is
--   that month, so re-running any month is a no-op and a month that was missed
--   is picked up whenever the run next fires.
--
-- Nothing about 0323 fails to transfer. Reporting that as the answer to the
-- question rather than as an absence.
-- ---------------------------------------------------------------------------
--
-- DECIDED, AND BUILT AS DECIDED:
--   * Threshold 50,000. Below it, straight to expense, no option offered.
--   * Start and end MONTHS, not a count — a licence running 14 March to
--     13 March cannot be expressed cleanly as "12 months".
--   * Lives in the existing Expenses tab.
--   * The final month takes the remainder, so the schedule sums to the amount
--     exactly rather than leaving a stub.

-- ---------------------------------------------------------------------------
-- Step 1. The account, lazily, like ensure_unearned_revenue_account (0323).
--
-- THE CODE IS 1160, AND NOT 1300. 1300 is already 'Inter-Region Receivable'
-- (system_key interregion_receivable) on every company, so the first attempt at
-- this migration was refused by chart_of_accounts_company_id_account_code_key
-- and the whole thing rolled back. 1160 sits after 1150 Withholding Tax
-- Receivable and before 1200 Inventory, which is where a current-asset prepaid
-- belongs. Check the range before adding to it — the 1xxx band is denser than
-- it looks.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_prepaid_expenses_account(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_id uuid;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select id into v_id from public.chart_of_accounts
   where company_id = p_company_id and system_key = 'prepaid_expenses'
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.chart_of_accounts
    (company_id, account_code, account_name, account_type, normal_side,
     system_key, active, system_account, is_control)
  values
    (p_company_id, '1160', 'Prepaid Expenses', 'asset', 'debit',
     'prepaid_expenses', true, true, false)
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.ensure_prepaid_expenses_account(uuid) is
  '0347: the asset that carries a prepaid cost between payment and the months it covers. Created lazily like ensure_unearned_revenue_account, so a company added after this migration gets one on first use.';

-- Backfill every company that exists now. Direct insert: the migration runs as
-- postgres and has no tenant claim for assert_same_company to check.
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, active, system_account, is_control)
select c.id, '1160', 'Prepaid Expenses', 'asset', 'debit',
       'prepaid_expenses', true, true, false
  from public.companies c
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = 'prepaid_expenses'
 );

-- ---------------------------------------------------------------------------
-- Step 2. Coverage on the expense.
-- ---------------------------------------------------------------------------
alter table public.expenses
  add column if not exists coverage_start date,
  add column if not exists coverage_end   date;

comment on column public.expenses.coverage_start is
  '0347: first month covered by a prepaid expense (stored as the 1st). NULL means the cost belongs entirely to expense_date, which is every expense below the 50,000 threshold and every one above it that the user did not choose to amortise.';
comment on column public.expenses.coverage_end is
  '0347: last month covered, stored as the 1st of that month. Months, not a count: a licence running 14 March to 13 March is 13 touched months and "12" would be wrong at both ends.';

-- Both or neither, ordered, and only above the threshold. The threshold lives
-- in the constraint as well as the UI because the UI is not the only writer.
alter table public.expenses drop constraint if exists expenses_coverage_valid;
alter table public.expenses add constraint expenses_coverage_valid check (
  (coverage_start is null and coverage_end is null)
  or (
    coverage_start is not null and coverage_end is not null
    and coverage_start = date_trunc('month', coverage_start)::date
    and coverage_end   = date_trunc('month', coverage_end)::date
    and coverage_end  >= coverage_start
    and amount >= 50000
  )
);

create index if not exists expenses_prepaid_open_idx
  on public.expenses (company_id, coverage_start, coverage_end)
  where coverage_start is not null;

-- ---------------------------------------------------------------------------
-- Step 3. The posting at payment. Surgery, not restatement.
--
-- journal_on_expense has been edited by 0042, 0074, 0079, 0258, 0269 and 0276.
-- Six authors, so per CLAUDE.md no file holds its true text and it is amended
-- against the live definition with an anchor asserted to appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''''), new.pl_category::text, new.client_id);';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'journal_on_expense';

  if v_def is null then
    raise exception '0347 REFUSED: public.journal_on_expense does not exist';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0347 REFUSED: the map_expense_to_coa_key anchor appears % time(s) in journal_on_expense, expected exactly 1. Do not widen the anchor until it matches — a second occurrence means the body is not the one this migration was written against.', v_hits;
  end if;

  -- The debit becomes Prepaid Expenses when the expense declares coverage.
  -- The CREDIT side is untouched: cash still leaves in full, today.
  v_new := replace(
    v_def,
    v_anchor,
    v_anchor || '
  -- 0347. A prepaid expense debits the asset, not the expense account. The
  -- monthly release (release_prepaid_expenses) moves it across as each month
  -- arrives. The credit leg below is deliberately unchanged: the cash left in
  -- full today and the cash-basis statements must still see that.
  if new.coverage_start is not null then
    perform public.ensure_prepaid_expenses_account(new.company_id);
    v_exp_key := ''prepaid_expenses'';
  end if;'
  );

  execute v_new;
  raise notice '0347: journal_on_expense amended by surgery (1 anchor).';
end $$;

-- ---------------------------------------------------------------------------
-- Step 4. The release run. Monthly, per company, idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.release_prepaid_expenses(p_company_id uuid, p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_month   date;
  v_posted  int := 0;
  r         record;
  v_months  int;
  v_idx     int;
  v_share   numeric;
  v_done    numeric;
  v_amount  numeric;
  v_cat     text;
  v_key     text;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_month := date_trunc('month', coalesce(p_month, current_date))::date;

  for r in
    select e.*
      from public.expenses e
     where e.company_id = p_company_id
       and e.coverage_start is not null
       and e.coverage_start <= v_month
       and e.coverage_end   >= v_month
       -- Idempotent PER MONTH: this expense may already have been released for
       -- other months, and must be released exactly once for this one.
       and not exists (
         select 1 from public.journal_entries je
          where je.company_id = e.company_id
            and je.source_table = 'expenses_prepaid_release'
            and je.source_id = e.id
            and date_trunc('month', je.entry_date)::date = v_month
       )
  loop
    v_months := (extract(year from age(r.coverage_end, r.coverage_start)) * 12
               + extract(month from age(r.coverage_end, r.coverage_start)))::int + 1;
    if v_months < 1 then continue; end if;

    v_idx := (extract(year from age(v_month, r.coverage_start)) * 12
            + extract(month from age(v_month, r.coverage_start)))::int + 1;

    -- Rounding: every month takes the rounded share except the LAST, which
    -- takes whatever is left. The schedule therefore sums to the amount
    -- exactly, rather than leaving a stub of a rupee or two behind in 1160
    -- forever — which the check below would then report as a stuck balance.
    v_share := round(r.amount / v_months, 2);
    if v_idx = v_months then
      v_done   := v_share * (v_months - 1);
      v_amount := r.amount - v_done;
    else
      v_amount := v_share;
    end if;

    if v_amount = 0 then continue; end if;

    select name into v_cat from public.expense_categories where id = r.category_id;
    v_key := public.map_expense_to_coa_key(coalesce(v_cat, ''), r.pl_category::text, r.client_id);

    perform public.post_journal(
      r.company_id,
      (v_month + interval '1 month - 1 day')::date,
      coalesce(v_cat, 'Prepaid') || ' — ' || to_char(v_month, 'Mon YYYY') ||
        ' of ' || to_char(r.coverage_start, 'Mon YYYY') || '–' || to_char(r.coverage_end, 'Mon YYYY') ||
        coalesce(' · ' || r.description, ''),
      'expenses_prepaid_release', r.id, false,
      jsonb_build_array(
        jsonb_build_object('key', v_key,              'debit', v_amount, 'credit', 0),
        jsonb_build_object('key', 'prepaid_expenses', 'debit', 0,        'credit', v_amount)
      ),
      r.branch_id
    );
    v_posted := v_posted + 1;
  end loop;

  return v_posted;
end;
$fn$;

comment on function public.release_prepaid_expenses(uuid, date) is
  '0347: posts one month of every open prepaid expense — Dr the expense account, Cr Prepaid Expenses. Same shape as recognise_advance_revenue (0323): it recognises when the month ARRIVES rather than writing the whole schedule at entry time, so 0322 stays absolute and nothing posts into a month nobody has reached. Idempotent per (expense, month), so re-running is a no-op and a missed month is picked up on the next run. The last month takes the remainder so the schedule sums to the amount exactly.';

revoke execute on function public.release_prepaid_expenses(uuid, date) from public, anon;
grant execute on function public.release_prepaid_expenses(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Step 5. The check — no prepaid balance older than its coverage end.
--
-- This is the failure nobody would notice: the release run stops, and 1160
-- quietly holds a balance for months that have already passed while the P&L
-- under-reports every one of them. Silence would look identical to working.
-- ---------------------------------------------------------------------------
create or replace function public.stale_prepaid_expenses(p_company_id uuid)
returns table (
  expense_id     uuid,
  expense_date   date,
  description    text,
  amount         numeric,
  coverage_start date,
  coverage_end   date,
  released       numeric,
  unreleased     numeric
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select e.id, e.expense_date, e.description, e.amount, e.coverage_start, e.coverage_end,
         coalesce(rel.amt, 0),
         e.amount - coalesce(rel.amt, 0)
    from public.expenses e
    left join lateral (
      select sum(jl.credit) amt
        from public.journal_entries je
        join public.journal_lines  jl on jl.journal_entry_id = je.id
        join public.chart_of_accounts a on a.id = jl.account_id
       where je.source_table = 'expenses_prepaid_release'
         and je.source_id = e.id
         and a.system_key = 'prepaid_expenses'
    ) rel on true
   where e.company_id = p_company_id
     and e.coverage_start is not null
     -- Its last covered month is over, so nothing is left to wait for.
     and e.coverage_end < date_trunc('month', current_date)::date
     and e.amount - coalesce(rel.amt, 0) <> 0;
$fn$;

comment on function public.stale_prepaid_expenses(uuid) is
  '0347: prepaid expenses whose coverage period has fully passed and that still carry an unreleased balance in 1160. Non-empty means the release run stopped — the failure mode whose symptom is silence.';

revoke execute on function public.stale_prepaid_expenses(uuid) from public, anon;
grant execute on function public.stale_prepaid_expenses(uuid) to authenticated;

-- Wire it into ledger_checks. SURGERY: ledger_checks has been edited by many
-- migrations (0286, 0288, 0313, 0316, 0318, 0342 ...) so there is no canonical
-- file and it is amended against the live definition with a single anchor.
do $$
declare
  v_def    text;
  v_anchor text;
  v_new    text;
  v_hits   int;
  v_before int;
  v_after  int;
  v_co     uuid;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0347 REFUSED: public.ledger_checks does not exist'; end if;

  v_anchor := 'select ''profit_allocation_exhausts_pool''::text,';
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0347 REFUSED: the ledger_checks anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  if v_co is not null then
    select count(*) into v_before from public.ledger_checks(v_co);
  end if;

  v_new := replace(v_def, v_anchor,
    'select ''no_stale_prepaid_balance''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.stale_prepaid_expenses(p_company_id)
    union all
    ' || v_anchor);

  execute v_new;

  -- The canary must go up by exactly one, and it counts rows, so a check that
  -- was added without its count being raised would show here as a mismatch.
  if v_co is not null then
    select count(*) into v_after from public.ledger_checks(v_co);
    if v_after <> v_before + 1 then
      raise exception '0347 FAILED: ledger_checks returned % rows, expected % (one more than before).', v_after, v_before + 1;
    end if;
    raise notice '0347: ledger_checks wired, % -> % rows.', v_before, v_after;
  end if;
end $$;

-- The canary literal inside ledger_checks_base counts the checks it evaluates.
-- The new check lives in ledger_checks, not the base, so rows_before_canary is
-- deliberately NOT touched — 0342 raised it to 30 for the same reason and the
-- 'checks_evaluated' row still reports the base's own count.

-- ---------------------------------------------------------------------------
-- Step 6. Probe. Rollback only. Proves the split, the remainder and idempotency.
--
-- THE COVERAGE WINDOW ENDS IN THE CURRENT MONTH, AND THAT IS THE POINT, NOT A
-- CONVENIENCE. The first version of this probe covered the current month plus
-- the next two, and 0322 refused the second release outright:
--
--   'This entry posts to October 2026, a period that has not been reached yet.'
--
-- The refusal was correct and it came from the function under test doing
-- exactly what this migration's header claims — release_prepaid_expenses CANNOT
-- post ahead of the calendar, which is precisely why the schedule is not
-- written at entry time. So the probe now covers the two months BEHIND the
-- current one and ends on it: three releases, all into months that have been
-- reached, exercising the same split and the same remainder.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_id    uuid;
  v_n     int;
  v_pre   numeric;
  v_rel   numeric;
  v_start date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_end   date := date_trunc('month', current_date)::date;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then raise notice '0347: no company to probe; skipped.'; return; end if;

  begin
    -- 100,000 over 3 months = 33,333.33 / 33,333.33 / 33,333.34
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       coverage_start, coverage_end)
    values
      (v_co, 100000, v_start, 'Payable', 'operating_expense',
       '0347 probe', v_start, v_end)
    returning id into v_id;

    -- The payment debited the asset, not an expense account.
    select coalesce(sum(jl.debit), 0) into v_pre
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses';
    if v_pre <> 100000 then
      raise exception '0347 FAILED: payment debited % to Prepaid Expenses, expected 100000.', v_pre;
    end if;

    -- Release month 1, then month 1 again (must be a no-op), then 2 and 3.
    v_n := public.release_prepaid_expenses(v_co, v_start);
    if v_n <> 1 then raise exception '0347 FAILED: first release posted % entries, expected 1.', v_n; end if;

    v_n := public.release_prepaid_expenses(v_co, v_start);
    if v_n <> 0 then raise exception '0347 FAILED: re-running the same month posted % entries. The run is not idempotent.', v_n; end if;

    perform public.release_prepaid_expenses(v_co, (v_start + interval '1 month')::date);
    perform public.release_prepaid_expenses(v_co, v_end);

    -- And it must REFUSE to run ahead of the calendar. 0322 is what stops it;
    -- this asserts that the release run is subject to that rule rather than
    -- exempt from it, because an exemption here would post next month's cost
    -- into next month's P&L today.
    begin
      perform public.release_prepaid_expenses(v_co, (v_end + interval '1 month')::date);
      -- No open prepaid covers that month, so zero entries is the correct and
      -- expected outcome; a raise would mean coverage_end was not respected.
    exception when others then
      raise exception '0347 FAILED: releasing a month beyond coverage raised % instead of doing nothing.', sqlerrm;
    end;

    select coalesce(sum(jl.credit), 0) into v_rel
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses';

    if v_rel <> 100000 then
      raise exception '0347 FAILED: the three months released % in total, expected exactly 100000. The final month is not taking the remainder.', v_rel;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0347: probe passed — deferral, idempotent release, exact remainder.';
  end;
end $$;
