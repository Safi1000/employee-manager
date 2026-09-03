-- 0356 — an expense has a service period, and it splits by days.
--
-- A bill covering 15 August to 15 September belongs to both months, and GGS
-- closes late — once every bill is in — precisely so a late-arriving bill can
-- land in the month it belongs to. There are no accruals and none are wanted;
-- the service period is what does that work instead.
--
-- ===========================================================================
-- REPORTED AS ASKED: IT NEEDS ITS OWN FIELDS. coverage_* CANNOT CARRY IT.
-- ===========================================================================
--
-- The two look like the same idea — "which months does this cost belong to" —
-- and they nearly are. But 0347's coverage_start/coverage_end carry three
-- DECIDED properties that this cannot have, and relaxing any of them would
-- break the prepaid ruling rather than extend it:
--
--   1. `amount >= 50000`, enforced by expenses_coverage_valid. That threshold
--      was decided deliberately — eleven journal entries to move 166 rupees is
--      more bookkeeping than the accuracy is worth. A SERVICE PERIOD has no
--      such floor: a 3,000 utility bill spanning two months still belongs to
--      two months, and it costs exactly two entries to say so.
--
--   2. FIRST-OF-MONTH AT BOTH ENDS, also enforced. That follows from "start and
--      end MONTHS, not a count". A service period is 15 August to 15 September
--      — the DAYS are the whole point, because they are what the split is
--      weighted by. Truncating to months would put half of September's cost
--      into August.
--
--   3. It splits EQUALLY per month, last month taking the remainder. A service
--      period splits BY DAYS, so a 17-day August and a 15-day September carry
--      different amounts from the same bill.
--
-- Reusing the columns would mean dropping the threshold constraint and the
-- month-truncation constraint, which is most of what makes prepaid prepaid.
--
-- THE DUPLICATION RISK IS REAL AND IS HANDLED. Two pairs of columns that both
-- mean "spread this cost over time" is exactly how two implementations of one
-- idea start. Two things keep them one mechanism:
--   * ONE release function. release_prepaid_expenses handles both shapes; there
--     is no second run to fall out of step.
--   * A CONSTRAINT forbidding both pairs on the same expense. They answer the
--     same question and an expense that answered it twice would be released
--     twice.
--
-- ===========================================================================
-- WHY THE SAME ASSET ACCOUNT (1160 Prepaid Expenses).
-- ===========================================================================
-- Strictly, a bill for service already received is an ACCRUAL, not a prepayment,
-- and would sit in a liability. But GGS does not accrue — the bill arrives
-- before the month closes, so the cost and the cash are recorded together and
-- the asset is extinguished within days. Opening a second control account to
-- hold a balance that is empty by the time anyone reads it would add a
-- reconciliation nobody benefits from. If GGS ever starts closing before the
-- bills are in, this decision is the one to revisit.

alter table public.expenses
  add column if not exists service_start date,
  add column if not exists service_end   date;

comment on column public.expenses.service_start is
  '0356: first day of the period this expense pays for. Actual DATE, not a month — the split across months is weighted by days, so 15 August is 15 August. Distinct from coverage_start (0347), which is month-granular, above a 50,000 threshold, and splits equally; see 0356''s header for why they cannot be one pair of columns.';
comment on column public.expenses.service_end is
  '0356: last day of the period this expense pays for, inclusive.';

alter table public.expenses drop constraint if exists expenses_service_period_valid;
alter table public.expenses add constraint expenses_service_period_valid check (
  (service_start is null and service_end is null)
  or (service_start is not null and service_end is not null and service_end >= service_start)
);

-- One question, one answer. An expense carrying both would be released twice.
alter table public.expenses drop constraint if exists expenses_one_spreading_mechanism;
alter table public.expenses add constraint expenses_one_spreading_mechanism check (
  coverage_start is null or service_start is null
);

create index if not exists expenses_service_open_idx
  on public.expenses (company_id, service_start, service_end)
  where service_start is not null;

-- ---------------------------------------------------------------------------
-- The posting at entry: the same deferral. Surgery on journal_on_expense,
-- whose 0347 clause is the anchor.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def   text;
  v_new   text;
  v_hits  int;
  a_clause text := 'if new.coverage_start is not null then';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'journal_on_expense';
  if v_def is null then raise exception '0356 REFUSED: journal_on_expense does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_clause, ''))) / length(a_clause);
  if v_hits <> 1 then
    raise exception '0356 REFUSED: the 0347 coverage clause appears % time(s), expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_clause,
    'if new.coverage_start is not null or new.service_start is not null then');
  execute v_new;
  raise notice '0356: journal_on_expense defers a service-period expense too.';
end $$;

-- ---------------------------------------------------------------------------
-- The release run learns the second shape. One function, two weightings.
-- ---------------------------------------------------------------------------
create or replace function public.release_prepaid_expenses(p_company_id uuid, p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_month   date;
  v_m_end   date;
  v_posted  int := 0;
  r         record;
  v_months  int;
  v_idx     int;
  v_share   numeric;
  v_done    numeric;
  v_amount  numeric;
  v_days    int;
  v_tot_d   int;
  v_prior   numeric;
  v_cat     text;
  v_key     text;
  v_label   text;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_month := date_trunc('month', coalesce(p_month, current_date))::date;
  v_m_end := (v_month + interval '1 month - 1 day')::date;

  for r in
    select e.*
      from public.expenses e
     where e.company_id = p_company_id
       and (
         -- 0347 shape: month-granular, equal split.
         (e.coverage_start is not null
          and e.coverage_start <= v_month and e.coverage_end >= v_month)
         or
         -- 0356 shape: day-granular, weighted split. The month qualifies when
         -- the service period overlaps it at all.
         (e.service_start is not null
          and e.service_start <= v_m_end and e.service_end >= v_month)
       )
       and not exists (
         select 1 from public.journal_entries je
          where je.company_id = e.company_id
            and je.source_table = 'expenses_prepaid_release'
            and je.source_id = e.id
            and date_trunc('month', je.entry_date)::date = v_month
       )
  loop
    if r.coverage_start is not null then
      -- ---- 0347: equal months, last takes the remainder ----
      v_months := (extract(year from age(r.coverage_end, r.coverage_start)) * 12
                 + extract(month from age(r.coverage_end, r.coverage_start)))::int + 1;
      if v_months < 1 then continue; end if;
      v_idx := (extract(year from age(v_month, r.coverage_start)) * 12
              + extract(month from age(v_month, r.coverage_start)))::int + 1;
      v_share := round(r.amount / v_months, 2);
      if v_idx = v_months then
        v_done   := v_share * (v_months - 1);
        v_amount := r.amount - v_done;
      else
        v_amount := v_share;
      end if;
      v_label := to_char(v_month, 'Mon YYYY') || ' of '
              || to_char(r.coverage_start, 'Mon YYYY') || '–' || to_char(r.coverage_end, 'Mon YYYY');
    else
      -- ---- 0356: weighted by DAYS in this month ----
      -- Days of the service period that fall inside this month, over the total
      -- days of the period. Both ends inclusive, which is why each is +1.
      v_days  := (least(r.service_end, v_m_end) - greatest(r.service_start, v_month))::int + 1;
      v_tot_d := (r.service_end - r.service_start)::int + 1;
      if v_days <= 0 or v_tot_d <= 0 then continue; end if;

      if v_m_end >= r.service_end then
        -- FINAL month: take whatever has not been released yet, so the schedule
        -- sums to the amount exactly however the daily rounding fell. The same
        -- remainder rule as 0347, expressed against what was actually posted
        -- rather than against an assumed equal share.
        select coalesce(sum(jl.credit), 0) into v_prior
          from public.journal_entries je
          join public.journal_lines jl on jl.journal_entry_id = je.id
          join public.chart_of_accounts a on a.id = jl.account_id
         where je.source_table = 'expenses_prepaid_release'
           and je.source_id = r.id
           and a.system_key = 'prepaid_expenses';
        v_amount := r.amount - v_prior;
      else
        v_amount := round(r.amount * v_days / v_tot_d, 2);
      end if;
      v_label := to_char(v_month, 'Mon YYYY') || ' — ' || v_days || '/' || v_tot_d || ' days of '
              || to_char(r.service_start, 'DD Mon') || '–' || to_char(r.service_end, 'DD Mon YYYY');
    end if;

    if v_amount = 0 then continue; end if;

    select name into v_cat from public.expense_categories where id = r.category_id;
    v_key := public.map_expense_to_coa_key(coalesce(v_cat, ''), r.pl_category::text, r.client_id);

    perform public.post_journal(
      r.company_id,
      v_m_end,
      coalesce(v_cat, 'Prepaid') || ' — ' || v_label || coalesce(' · ' || r.description, ''),
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
  '0347/0356: releases one month of every open deferred expense — Dr the expense account, Cr Prepaid Expenses. TWO SHAPES, one function: coverage_start/end (0347) splits equally by month above a 50,000 threshold; service_start/end (0356) splits by DAYS across the months a bill actually covers, at any amount. Both idempotent per (expense, month); both make the final month take the remainder so the schedule sums exactly. A constraint forbids an expense carrying both.';

revoke execute on function public.release_prepaid_expenses(uuid, date) from public, anon;
grant execute on function public.release_prepaid_expenses(uuid, date) to authenticated;

-- The staleness check must see the second shape too, or a service-period bill
-- whose release run stopped would be invisible to it.
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
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  select e.id, e.expense_date, e.description, e.amount,
         coalesce(e.coverage_start, e.service_start),
         coalesce(e.coverage_end,   e.service_end),
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
     and (e.coverage_start is not null or e.service_start is not null)
     and coalesce(e.coverage_end, e.service_end) < date_trunc('month', current_date)::date
     and e.amount - coalesce(rel.amt, 0) <> 0;
end;
$fn$;

revoke execute on function public.stale_prepaid_expenses(uuid) from public, anon;
grant execute on function public.stale_prepaid_expenses(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Probe: the straddling bill from the brief, 15 Aug – 15 Sep.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co   uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_id   uuid;
  v_a    numeric; v_b numeric; v_tot numeric;
  v_s    date := (date_trunc('month', current_date) - interval '1 month' + interval '14 days')::date;
  v_e    date := (date_trunc('month', current_date) + interval '14 days')::date;
  v_days1 int; v_days2 int;
begin
  if v_co is null then raise notice '0356: GGS absent; probe skipped.'; return; end if;

  begin
    insert into public.expenses (company_id, amount, expense_date, payment_mode, pl_category,
                                 description, service_start, service_end)
    values (v_co, 10000, current_date, 'Payable', 'operating_expense',
            '0356 probe — straddling bill', v_s, v_e)
    returning id into v_id;

    -- Both months are in the past or current, so both can be released now.
    perform public.release_prepaid_expenses(v_co, v_s);
    perform public.release_prepaid_expenses(v_co, v_e);

    select coalesce(sum(jl.credit), 0) into v_tot
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses';

    if v_tot <> 10000 then
      raise exception '0356 FAILED: the two months released % of 10000. The split does not sum to the bill.', v_tot;
    end if;

    -- And it must be WEIGHTED, not halved: the two months have different day
    -- counts, so equal amounts would mean the day weighting never ran.
    v_days1 := (least(v_e, (date_trunc('month', v_s) + interval '1 month - 1 day')::date) - v_s)::int + 1;
    v_days2 := (v_e - greatest(v_s, date_trunc('month', v_e)::date))::int + 1;

    select coalesce(sum(jl.credit), 0) into v_a
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release' and je.source_id = v_id
       and a.system_key = 'prepaid_expenses'
       and date_trunc('month', je.entry_date)::date = date_trunc('month', v_s)::date;

    if v_days1 <> v_days2 and v_a = 5000 then
      raise exception '0356 FAILED: month one took exactly half (%) despite %/% day split — the weighting did not apply.',
        v_a, v_days1, v_days2;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0356: probe passed — straddling bill split by days, summing to the amount.';
  end;
end $$;
