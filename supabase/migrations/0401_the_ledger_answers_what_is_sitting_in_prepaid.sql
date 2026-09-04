-- 0401 — the ledger answers what is sitting in prepaid.
--
-- An operator asking "what is in prepaid and when does it clear" has nowhere to
-- look. The BALANCE is on 1160 and no_stale_prepaid_balance (0347) watches it.
-- The SCHEDULE — which expense, how much of it has crossed, which month it
-- finishes — exists only as journal entries nobody groups.
--
-- THE FRONTEND MUST NOT COMPUTE THIS. Released-to-date is a sum over
-- journal_lines. A screen that adds it up is the Trial Balance defect again:
-- 1,304 lines pulled and summed in JavaScript beside a view that answered in
-- 56 rows. The ledger answers; the screen reads.
--
-- WHY IT IS NOT A VIEW. stale_prepaid_expenses (0347/0356) is a function
-- because it takes the company as an argument and asserts the tenant claim
-- against it. This is its sibling and takes the same shape for the same
-- reason — a view would rely on RLS across four joined tables to scope it, and
-- one of them (chart_of_accounts) is the kind of reference table whose policy
-- is written for reading, not for scoping somebody else's aggregate.
--
-- ── WHAT IT RETURNS, AND THE ONE FIELD THAT IS NOT A SUM ───────────────────
--
--   shape           'prepaid' (0347) or 'service_period' (0356). Both defer
--                   into 1160 and both are released by the same run, but they
--                   split differently and the screen must be able to say which
--                   — "6 equal months" and "32 days across two months" are not
--                   the same sentence.
--   amount          what was deferred at entry.
--   released        Cr to prepaid_expenses across every release entry.
--   remaining       amount - released. THE FIGURE ON 1160 FOR THIS EXPENSE.
--   months_total    how many months the schedule spans.
--   months_released how many have actually posted. Not derived from the dates:
--                   COUNTED FROM THE ENTRIES. A count taken from the calendar
--                   would report the schedule as on track while the run was
--                   stopped, which is the exact failure this is meant to show.
--   final_month     the month it finishes.
--   is_stale        its coverage has fully passed and it still carries a
--                   balance — the same condition stale_prepaid_expenses reports
--                   and no_stale_prepaid_balance goes red on, surfaced per row
--                   so the screen can mark the offending line rather than tell
--                   the operator that something, somewhere, is stuck.
--
-- OPEN AND CLOSED BOTH. A settled prepaid is not noise: "it finished in March"
-- is the answer to "when does it clear" for an expense somebody is looking at.
-- The caller filters; a function that pre-decided would need a second one the
-- first time anybody wanted the other half.

create or replace function public.prepaid_schedule(p_company_id uuid)
returns table (
  expense_id      uuid,
  expense_date    date,
  description     text,
  category_name   text,
  shape           text,
  period_start    date,
  period_end      date,
  amount          numeric,
  released        numeric,
  remaining       numeric,
  months_total    int,
  months_released int,
  final_month     date,
  is_stale        boolean
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
  select
    e.id,
    e.expense_date,
    e.description,
    c.name,
    case when e.coverage_start is not null then 'prepaid' else 'service_period' end,
    coalesce(e.coverage_start, e.service_start),
    coalesce(e.coverage_end,   e.service_end),
    e.amount,
    coalesce(rel.amt, 0),
    e.amount - coalesce(rel.amt, 0),
    -- Months the schedule SPANS. Both shapes are month-inclusive at both ends:
    -- a service period of 15 Aug to 15 Sep touches two months, and a licence
    -- running 14 March to 13 March touches thirteen. "12" would be wrong at
    -- both ends, which is why 0347 stored months rather than a count.
    ((extract(year from age(
        date_trunc('month', coalesce(e.coverage_end, e.service_end)),
        date_trunc('month', coalesce(e.coverage_start, e.service_start)))) * 12
    + extract(month from age(
        date_trunc('month', coalesce(e.coverage_end, e.service_end)),
        date_trunc('month', coalesce(e.coverage_start, e.service_start)))))::int) + 1,
    coalesce(rel.months, 0)::int,
    date_trunc('month', coalesce(e.coverage_end, e.service_end))::date,
    coalesce(e.coverage_end, e.service_end) < date_trunc('month', current_date)::date
      and e.amount - coalesce(rel.amt, 0) <> 0
  from public.expenses e
  left join public.expense_categories c on c.id = e.category_id
  left join lateral (
    select sum(jl.credit) amt,
           count(distinct date_trunc('month', je.entry_date)) months
      from public.journal_entries je
      join public.journal_lines  jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'expenses_prepaid_release'
       and je.source_id = e.id
       and a.system_key = 'prepaid_expenses'
  ) rel on true
  where e.company_id = p_company_id
    and (e.coverage_start is not null or e.service_start is not null)
  order by (e.amount - coalesce(rel.amt, 0)) desc, e.expense_date desc;
end;
$fn$;

comment on function public.prepaid_schedule(uuid) is
  '0401: every deferred expense with its release schedule — amount, released to date, remaining, months released out of months spanned, the month it finishes, and whether it is stale. Released-to-date is a sum over journal_lines and belongs here rather than in a screen (see CLAUDE.md, "Reading versus computing"). months_released is COUNTED FROM THE ENTRIES, never derived from the calendar: a calendar count would report a schedule as on track while the run was stopped. Returns settled schedules as well as open ones — "it finished in March" is an answer, and the caller filters.';

revoke execute on function public.prepaid_schedule(uuid) from anon, public;
grant  execute on function public.prepaid_schedule(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Probe. Rollback only.
--
-- IT MUST DISAGREE WITH THE CALENDAR, and that is the assertion worth having.
-- Every other field could be got right by a function that read the dates and
-- assumed the run had done its job. Releasing ONE month of a three-month
-- schedule and then asserting months_released = 1 while months_total = 3 is the
-- only probe here that a calendar-derived implementation would fail.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_id    uuid;
  r       record;
  v_start date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_end   date := date_trunc('month', current_date)::date;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is null then raise notice '0401: no company to probe; skipped.'; return; end if;

  begin
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       coverage_start, coverage_end)
    values
      (v_co, 90000, v_start, 'Payable', 'operating_expense',
       '0401 probe', v_start, v_end)
    returning id into v_id;

    -- Nothing released yet.
    select * into r from public.prepaid_schedule(v_co) where expense_id = v_id;
    if r.expense_id is null then
      raise exception '0401 FAILED: a deferred expense does not appear in the schedule at all.';
    end if;
    if r.shape <> 'prepaid' then
      raise exception '0401 FAILED: a coverage_start expense reported shape "%".', r.shape;
    end if;
    if r.months_total <> 3 then
      raise exception '0401 FAILED: a three-month window reported months_total %.', r.months_total;
    end if;
    if r.released <> 0 or r.remaining <> 90000 then
      raise exception '0401 FAILED: an unreleased expense reported released % / remaining %.', r.released, r.remaining;
    end if;
    if r.months_released <> 0 then
      raise exception '0401 FAILED: nothing has been released and months_released is %. It is being derived from the dates.', r.months_released;
    end if;

    -- ONE month across. The calendar still says three.
    perform public.release_prepaid_expenses(v_co, v_start);

    select * into r from public.prepaid_schedule(v_co) where expense_id = v_id;
    if r.months_released <> 1 then
      raise exception '0401 FAILED: one month released, months_released = %. A calendar-derived count would say 3 here, and would be wrong in exactly the case this figure exists for.', r.months_released;
    end if;
    if r.released <> 30000 or r.remaining <> 60000 then
      raise exception '0401 FAILED: after one month of 90000/3, released = % and remaining = %.', r.released, r.remaining;
    end if;
    if r.final_month <> v_end then
      raise exception '0401 FAILED: final_month reported % rather than %.', r.final_month, v_end;
    end if;
    if r.is_stale then
      raise exception '0401 FAILED: a schedule whose last month is the current one is reported stale.';
    end if;

    -- And the 0356 shape is named differently, or the screen cannot tell the
    -- two sentences apart.
    insert into public.expenses
      (company_id, amount, expense_date, payment_mode, pl_category, description,
       service_start, service_end)
    values
      (v_co, 10000, current_date, 'Payable', 'operating_expense',
       '0401 probe — service period',
       (v_start + interval '14 days')::date, (v_end + interval '14 days')::date)
    returning id into v_id;

    select * into r from public.prepaid_schedule(v_co) where expense_id = v_id;
    if r.shape <> 'service_period' then
      raise exception '0401 FAILED: a service_start expense reported shape "%".', r.shape;
    end if;
    if r.months_total <> 3 then
      raise exception '0401 FAILED: a period spanning three calendar months reported months_total %.', r.months_total;
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0401: probe passed — both shapes named, months counted from entries and not from the calendar.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- prepaid_schedule(p_company_id) is new and reads four tenant-scoped tables.
--
-- Asserted against the DETECTOR rather than against a reading of the source.
-- Four guard regressions so far — 0348 fixed two, 0352 one, 0363 the fourth —
-- and every one was a guard that was written correctly and never checked
-- against the thing that has to be able to READ it. Being right is not the
-- same as being verifiable: tenant_guard_covered() matches on the parameter
-- name appearing inside the guard call, so a guard that resolves the company
-- some other way is invisible to it and counts as absent.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0401 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see. Resolve the company INSIDE the guard call and put the guard ahead of every read — do not add an exemption.',
      v_n, v_who;
  end if;
end $$;
