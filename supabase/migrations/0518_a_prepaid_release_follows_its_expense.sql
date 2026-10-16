-- 0518 — A prepaid release follows its expense: released means net of
-- reversals, an edit re-runs the schedule, and a check compares what was
-- released with what the schedule says, month by month.
--
-- ===========================================================================
-- WHAT WAS WRONG, AND HOW IT WAS FOUND
-- ===========================================================================
--
-- "Nova Isb Salaries" (expense 2b2f996d…, service 1–31 Aug 2026, paid in cash
-- 29 Sep) was released to August at 172,515 by the monthly run at 02:20 on
-- 1 Oct 2026. At 10:33 the same day the expense was edited to 142,515.
-- journal_on_expense reversed and re-posted the EXPENSE entry (Dr 1160 142,515)
-- and left the RELEASE alone, because nothing ties a release to an edit. So
-- August carries 30,000 of cost that was never paid, and Prepaid Expenses keeps
-- a 30,000 credit that nothing will ever clear. Found 2026-10-17 while
-- specifying the 31 August cutover; no_stale_prepaid_balance had been red over
-- it (6, Nova at -30,000) since 1 Oct — the check saw it, nothing stopped it.
--
-- Why a re-run could not have fixed it, and why this migration starts with the
-- counting: release_prepaid_expenses measured "released" as sum(jl.credit) on
-- Prepaid Expenses, so a reversal — a DEBIT — was invisible to it; and it
-- treated a month as done if ANY release entry existed for it, reversed or not.
-- Reverse the bad release and run the job again, and the job sees August as
-- done and 172,515 as released. stale_prepaid_expenses and prepaid_schedule
-- read the same sum(jl.credit) and had the same blindness.
--
-- ===========================================================================
-- WHAT THIS MIGRATION DOES, IN ORDER
-- ===========================================================================
--
-- 1. THE COUNTING (surgery; release_prepaid_expenses has three authors — 0347,
--    0356, 0399 — and stale_prepaid_expenses three — 0347, 0348, 0356 — so
--    neither has a canonical file):
--      released            = credits LESS debits on Prepaid Expenses, so a
--                            reversal nets out the release it reverses;
--      a month is done     = it has a release entry that is not itself a
--                            reversal and has not been reversed.
--    prepaid_schedule (one author, 0401) gets the same two changes so the
--    screen and the job cannot disagree.
--    release_prepaid_expenses also learns to run for ONE expense: when the
--    session setting bastion.prepaid_only_expense names an expense id, the
--    catch-up and the loop see only that expense. Nothing sets it except
--    prepaid_reschedule() below, which clears it again. The monthly run never
--    sets it and behaves exactly as before.
--
-- 2. prepaid_reschedule(expense): reverses every live release of that expense,
--    EACH IN ITS OWN MONTH (reverse_journal_entry, 0502 — same landing rule as
--    every reversal: an open month absorbs its own correction, a closed one
--    moves it to today), then re-runs release_prepaid_expenses for that expense
--    alone, through the last month the schedule had reached. Never further: the
--    monthly run still owns the calendar. Not callable by any user.
--    If a re-released month is CLOSED, post_journal refuses and the edit that
--    caused it is refused with it. That is deliberate — a refusal is a control,
--    and the alternative is a closed month silently keeping the wrong figure.
--
-- 3. THE CORRECTION: prepaid_reschedule(Nova). The same path every future edit
--    takes, so the fix is also the first use of the fix. Reverses the 172,515
--    release dated 31 Aug and re-releases August at 142,515, dated 31 Aug.
--    Net: 5900 August -30,000; Nova's Prepaid balance 0.
--
-- 4. THE TRIGGER — the actual fix. trg_yyz_expense_prepaid_follows, AFTER
--    UPDATE OR DELETE on expenses, after trg_yyy_expenses_journal. On a change
--    to any field the schedule reads — amount, coverage_start/end,
--    service_start/end, category_id, pl_category, client_id, branch_id — it
--    calls prepaid_reschedule. On DELETE it reverses the releases (the row is
--    gone, so nothing re-runs). An edit that touches none of those fields does
--    nothing.
--
-- 5. THE SHARPER CHECK: prepaid_schedule_drift(company) and its ledger_checks
--    arm prepaid_released_matches_schedule. For every expense with a schedule
--    and every month the schedule covers that is due — a completed month, or
--    the current month once its release has posted — cumulative released
--    (net) must equal cumulative scheduled. no_stale_prepaid_balance only fires
--    after a schedule ENDS; this fires the month it goes wrong.
--    The schedule here is computed INDEPENDENTLY of release_prepaid_expenses,
--    by the same predicates and the same rounding. That is a second copy of
--    the arithmetic and it is deliberate: a check that called the release
--    function could not catch the release function being wrong, the same
--    reason ar_control_equals_open_invoices sums invoices instead of reading
--    1100. If either side's rule changes, change both — this check going red
--    on every schedule at once is how a one-sided change announces itself.
--    At apply, section 6 asserts the two copies agree on every expense that
--    has ever been released.
--
-- ===========================================================================
-- MEASURED BEFORE (prod, 2026-10-17, read-only)
-- ===========================================================================
--   Nova: amount 142,515; one live release, 31 Aug 2026, Prepaid credit 172,515.
--   GGS no_stale_prepaid_balance: red, 6 (Nova -30,000 plus five expenses
--   entered 2–16 Oct for service already past, never yet released: Accomodation
--   rent 60,000; Eobi paid for 100 guards 244,200; FBR Tax paid 27,013; Office
--   rent and water 90,000; till september 43,000). SHAYAN_A has no expense with
--   a schedule.
--   Canary 44 (0516). This adds one check: 45.
--   The five never-released expenses are red in the new check too, by design:
--   their months are past and nothing has been released. They release at the
--   next monthly run (1 Nov 02:20) and the check goes green on its own. Two
--   are not prepaid at all — EOBI and FBR tax are statutory payments booked on
--   an asset — and are a separate pass, not this migration.
--
-- ===========================================================================
-- A CORRECTION TO AN EARLIER NOTE (A comment is a measurement of the moment
-- it was written — the correction goes in the new file)
-- ===========================================================================
--   0516's client_cover() carries "DEFERRED: ContractedVsDeployed.tsx should
--   read this function once 0516 is applied". It does, since commit 0da33ff
--   (2026-10-16). That note is no longer DEFERRED; it is done. 0516 is not
--   edited, which would manufacture drift.

-- ---------------------------------------------------------------------------
-- 0. BEFORE: the named red set, the figures the correction must move, and the
--    figures it must not.
-- ---------------------------------------------------------------------------
create temp table t0518_red on commit drop as
select c.id co, c.name, lc.check_name, lc.actual, lc.passed
  from public.companies c, public.ledger_checks(c.id) lc;

create temp table t0518_before on commit drop as
select
  (select count(*) from pg_proc where proname = 'prepaid_reschedule' and pronamespace = 'public'::regnamespace) = 0 as fresh,
  (select company_id from public.expenses where id = '2b2f996d-7885-4005-8c96-5898f52ad37f') as co,
  (select coalesce(sum(jl.debit - jl.credit), 0)
     from public.journal_entries je
     join public.journal_lines jl on jl.journal_entry_id = je.id
     join public.chart_of_accounts a on a.id = jl.account_id
    where je.company_id = (select company_id from public.expenses where id = '2b2f996d-7885-4005-8c96-5898f52ad37f')
      and a.account_code = '5900'
      and je.entry_date between '2026-08-01' and '2026-08-31') as aug_5900,
  (select count(*) from public.journal_entries je
    where je.source_table = 'expenses_prepaid_release'
      and je.source_id <> '2b2f996d-7885-4005-8c96-5898f52ad37f') as other_releases,
  (select count(*) from public.journal_entries) as entries;

-- ---------------------------------------------------------------------------
-- 1. THE COUNTING — surgery against the live definitions.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.surg0518(p_fn text, p_key text, p_old text, p_new text, p_marker text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_marker in v_def) > 0 then
    raise notice '0518: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0518 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

-- 1a. release_prepaid_expenses: one-expense mode.
select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_only$k$,
  $a$  v_label   text;$a$,
  $b$  v_label   text;
  v_only    uuid := nullif(current_setting('bastion.prepaid_only_expense', true), '')::uuid;  -- 0518: one expense, set only by prepaid_reschedule$b$,
  $m$v_only    uuid := nullif(current_setting('bastion.prepaid_only_expense', true), '')::uuid;$m$);

select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_from_only$k$,
  $a$     and e.amount <> coalesce(($a$,
  $b$     and (v_only is null or e.id = v_only)  /* 0518: one expense */
     and e.amount <> coalesce(($b$,
  $m$     and (v_only is null or e.id = v_only)  /* 0518: one expense */$m$);

select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_loop_only$k$,
  $a$       -- THE IDEMPOTENCE THE CATCH-UP RIDES ON.$a$,
  $b$       and (v_only is null or e.id = v_only)  /* 0518: one expense */
       -- THE IDEMPOTENCE THE CATCH-UP RIDES ON.$b$,
  $m$       and (v_only is null or e.id = v_only)  /* 0518: one expense */
       -- THE IDEMPOTENCE$m$);

-- 1b. release_prepaid_expenses: released is net; a reversed release does not
--     mark a month done.
select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_from_net$k$,
  $a$       select sum(jl.credit)$a$,
  $b$       select sum(jl.credit - jl.debit)  /* 0518: net of reversals */$b$,
  $m$       select sum(jl.credit - jl.debit)  /* 0518: net of reversals */$m$);

select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_prior_net$k$,
  $a$select coalesce(sum(jl.credit), 0) into v_prior$a$,
  $b$select coalesce(sum(jl.credit - jl.debit), 0) into v_prior  /* 0518: net of reversals */$b$,
  $m$select coalesce(sum(jl.credit - jl.debit), 0) into v_prior$m$);

select pg_temp.surg0518($f$public.release_prepaid_expenses(uuid,date)$f$, $k$rpe_done$k$,
  $a$            and date_trunc('month', je.entry_date)::date = v_month$a$,
  $b$            and date_trunc('month', je.entry_date)::date = v_month
            and not je.is_reversal  /* 0518: a reversed release does not mark the month done */
            and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)$b$,
  $m$/* 0518: a reversed release does not mark the month done */$m$);

-- 1c. stale_prepaid_expenses and prepaid_schedule read the same balance.
select pg_temp.surg0518($f$public.stale_prepaid_expenses(uuid)$f$, $k$spe_net$k$,
  $a$      select sum(jl.credit) amt$a$,
  $b$      select sum(jl.credit - jl.debit) amt  /* 0518: net of reversals */$b$,
  $m$      select sum(jl.credit - jl.debit) amt  /* 0518: net of reversals */$m$);

select pg_temp.surg0518($f$public.prepaid_schedule(uuid)$f$, $k$ps_net$k$,
  $a$    select sum(jl.credit) amt,$a$,
  $b$    select sum(jl.credit - jl.debit) amt,  /* 0518: net of reversals */$b$,
  $m$    select sum(jl.credit - jl.debit) amt,  /* 0518: net of reversals */$m$);

select pg_temp.surg0518($f$public.prepaid_schedule(uuid)$f$, $k$ps_months$k$,
  $a$           count(distinct date_trunc('month', je.entry_date)) months$a$,
  $b$           count(distinct date_trunc('month', je.entry_date))
             filter (where not je.is_reversal
                       and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)) months  /* 0518: live releases only */$b$,
  $m$/* 0518: live releases only */$m$);

-- ---------------------------------------------------------------------------
-- 2. prepaid_reschedule — reverse every live release of one expense, each in
--    its own month, and re-run that expense's schedule to where it had reached.
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_reschedule(p_expense_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_co      uuid;
  v_through date;
  v_posted  integer := 0;
  r         record;
begin
  -- tenant guard [resolved]: owning company looked up from p_expense_id via
  -- public.expenses, or — after a DELETE, when the row is gone — via the
  -- release entries it left.
  select company_id into v_co from public.expenses where id = p_expense_id;
  if v_co is null then
    select company_id into v_co from public.journal_entries
     where source_table = 'expenses_prepaid_release' and source_id = p_expense_id
     limit 1;
  end if;
  if v_co is null then return 0; end if;
  perform public.assert_same_company(v_co);

  -- How far the schedule had reached, read BEFORE anything is reversed.
  select max(date_trunc('month', je.entry_date))::date into v_through
    from public.journal_entries je
   where je.company_id = v_co
     and je.source_table = 'expenses_prepaid_release' and je.source_id = p_expense_id
     and not je.is_reversal
     and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id);
  if v_through is null then return 0; end if;   -- nothing released yet: the monthly run owns it

  for r in
    select je.id
      from public.journal_entries je
     where je.company_id = v_co
       and je.source_table = 'expenses_prepaid_release' and je.source_id = p_expense_id
       and not je.is_reversal
       and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)
     order by je.entry_date, je.created_at
  loop
    perform public.reverse_journal_entry(r.id, 'the expense changed; its schedule was re-run (0518)');
  end loop;

  if exists (select 1 from public.expenses where id = p_expense_id) then
    perform set_config('bastion.prepaid_only_expense', p_expense_id::text, true);
    v_posted := public.release_prepaid_expenses(v_co, v_through);
    perform set_config('bastion.prepaid_only_expense', '', true);
  end if;
  return v_posted;
end;
$function$;

comment on function public.prepaid_reschedule(uuid) is
  '0518. Reverses every live release of one expense, each in its own month, and re-runs release_prepaid_expenses for that expense alone through the last month it had reached. Called by trg_yyz_expense_prepaid_follows and by 0518''s correction; not callable by users.';

revoke execute on function public.prepaid_reschedule(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE CORRECTION — Nova, through the same path every future edit takes.
-- ---------------------------------------------------------------------------
do $$
declare
  v_exp   constant uuid := '2b2f996d-7885-4005-8c96-5898f52ad37f';
  v_amt   numeric;
  v_net   numeric;
  v_live  int;
  v_live_d date;
  v_live_c numeric;
begin
  select amount into v_amt from public.expenses where id = v_exp;
  select coalesce(sum(jl.credit - jl.debit), 0) into v_net
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    join public.chart_of_accounts a on a.id = jl.account_id and a.system_key = 'prepaid_expenses'
   where je.source_table = 'expenses_prepaid_release' and je.source_id = v_exp;

  if v_amt = 142515 and v_net = 142515 then
    raise notice '0518: Nova already released at 142,515 — correction skipped.';
    return;
  end if;

  select count(*), min(je.entry_date),
         min((select sum(jl.credit) from public.journal_lines jl
                join public.chart_of_accounts a on a.id = jl.account_id and a.system_key = 'prepaid_expenses'
               where jl.journal_entry_id = je.id))
    into v_live, v_live_d, v_live_c
    from public.journal_entries je
   where je.source_table = 'expenses_prepaid_release' and je.source_id = v_exp
     and not je.is_reversal
     and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id);

  if v_amt is distinct from 142515 or v_live <> 1 or v_live_d <> date '2026-08-31' or v_live_c <> 172515 then
    raise exception '0518 REFUSED: Nova is not in the state this correction was written for (amount %, % live release(s), dated %, credit %). Expected 142,515 / 1 / 2026-08-31 / 172,515.',
      v_amt, v_live, v_live_d, v_live_c;
  end if;

  perform public.prepaid_reschedule(v_exp);
end $$;

-- ---------------------------------------------------------------------------
-- 4. THE TRIGGER — an edit to anything the schedule reads re-runs it.
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_follows_expense()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.prepaid_reschedule(old.id);   -- the row is gone: reverses, re-runs nothing
    return old;
  end if;

  -- Every field release_prepaid_expenses reads. Add to this list whenever that
  -- function starts reading another — the same discipline as 0256 for postings.
  if old.amount         is distinct from new.amount
     or old.coverage_start is distinct from new.coverage_start
     or old.coverage_end   is distinct from new.coverage_end
     or old.service_start  is distinct from new.service_start
     or old.service_end    is distinct from new.service_end
     or old.category_id    is distinct from new.category_id
     or old.pl_category    is distinct from new.pl_category
     or old.client_id      is distinct from new.client_id
     or old.branch_id      is distinct from new.branch_id then
    perform public.prepaid_reschedule(new.id);
  end if;
  return new;
end;
$function$;

revoke execute on function public.prepaid_follows_expense() from public, anon, authenticated;

drop trigger if exists trg_yyz_expense_prepaid_follows on public.expenses;
create trigger trg_yyz_expense_prepaid_follows
  after update or delete on public.expenses
  for each row execute function public.prepaid_follows_expense();

-- ---------------------------------------------------------------------------
-- 5. THE SHARPER CHECK — released to date against scheduled to date, per
--    expense per month.
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_schedule_drift(p_company_id uuid)
returns table(expense_id uuid, description text, month date, scheduled_to_date numeric, released_to_date numeric, difference numeric)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- 0518. The schedule is computed here INDEPENDENTLY of release_prepaid_expenses
  -- (same predicates, same rounding) so that this check can catch that function
  -- being wrong. Change both or neither.
  return query
  with e as (
    select x.id, x.description, x.amount, x.coverage_start, x.coverage_end, x.service_start, x.service_end
      from public.expenses x
     where x.company_id = p_company_id
       and (x.coverage_start is not null or x.service_start is not null)
  ),
  rel as (
    -- every release line on Prepaid, reversals included, by the month it is dated
    select je.source_id, date_trunc('month', je.entry_date)::date m,
           sum(jl.credit - jl.debit) net,
           bool_or(not je.is_reversal
                   and not exists (select 1 from public.journal_entries rv where rv.reversal_of_entry_id = je.id)) live
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id and a.system_key = 'prepaid_expenses'
     where je.company_id = p_company_id and je.source_table = 'expenses_prepaid_release'
     group by 1, 2
  ),
  mo as (
    -- the months the schedule covers, by the release run's own predicates
    select e.*, gs::date m, (gs + interval '1 month - 1 day')::date m_end,
           ((extract(year from age(e.coverage_end, e.coverage_start)) * 12
            + extract(month from age(e.coverage_end, e.coverage_start)))::int + 1) n_months,
           ((extract(year from age(gs::date, e.coverage_start)) * 12
            + extract(month from age(gs::date, e.coverage_start)))::int + 1) idx
      from e,
           generate_series(date_trunc('month', coalesce(e.coverage_start, e.service_start)),
                           date_trunc('month', coalesce(e.coverage_end, e.service_end)),
                           interval '1 month') gs
     where (e.coverage_start is not null and e.coverage_start <= gs::date and e.coverage_end >= gs::date)
        or (e.coverage_start is null and e.service_start <= (gs + interval '1 month - 1 day')::date and e.service_end >= gs::date)
  ),
  sched as (
    select mo.id, mo.description, mo.m,
           case
             -- 0347 shape: equal months, the last takes the remainder
             when mo.coverage_start is not null then
               case when mo.idx >= mo.n_months then mo.amount
                    else round(mo.amount / mo.n_months, 2) * mo.idx end
             -- 0356 shape: by days; the final month takes the remainder
             when mo.m_end >= mo.service_end then mo.amount
             else sum(round(mo.amount
                            * ((least(mo.service_end, mo.m_end) - greatest(mo.service_start, mo.m))::int + 1)
                            / ((mo.service_end - mo.service_start)::int + 1), 2))
                    over (partition by mo.id order by mo.m)
           end sched_cum
      from mo
  ),
  due as (
    select s.*,
           coalesce((select sum(r.net) from rel r where r.source_id = s.id and r.m <= s.m), 0) rel_cum
      from sched s
     where s.m < date_trunc('month', current_date)::date
        or exists (select 1 from rel r where r.source_id = s.id and r.m = s.m and r.live)
  )
  select d.id, d.description, d.m, d.sched_cum, d.rel_cum, d.rel_cum - d.sched_cum
    from due d
   where abs(d.rel_cum - d.sched_cum) > 0.005
   order by d.m, d.description;
end;
$function$;

comment on function public.prepaid_schedule_drift(uuid) is
  '0518. Every (expense, due month) where cumulative released (net of reversals) differs from cumulative scheduled. Computed independently of release_prepaid_expenses on purpose; change both or neither. Feeds ledger_checks: prepaid_released_matches_schedule.';

revoke execute on function public.prepaid_schedule_drift(uuid) from public, anon;
grant execute on function public.prepaid_schedule_drift(uuid) to authenticated, service_role;

-- 5b. Wire it into ledger_checks and move the canary, asserting the difference
--     rather than writing a literal believed to be right.
do $$
declare v_before int; v_after int; v_co uuid;
begin
  if position('prepaid_released_matches_schedule' in pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure)) > 0 then
    raise notice '0518: ledger_checks already carries prepaid_released_matches_schedule.';
    return;
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_before from public.ledger_checks(v_co);

  perform pg_temp.surg0518($f$public.ledger_checks(uuid)$f$, $k$lc_arm$k$,
    $a$    select 'no_definer_function_crosses_a_branch'::text,$a$,
    $b$    -- 0518. Released to date against scheduled to date, per expense per
    -- month. no_stale_prepaid_balance only fires after a schedule ends.
    select 'prepaid_released_matches_schedule'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.prepaid_schedule_drift(p_company_id)
    union all
    select 'no_definer_function_crosses_a_branch'::text,$b$,
    $m$'prepaid_released_matches_schedule'$m$);

  perform pg_temp.surg0518($f$public.ledger_checks(uuid)$f$, $k$lc_canary$k$,
    $a$    from (select 44::numeric n) e (n);   -- expected_check_count (0516: +5)$a$,
    $b$    from (select 45::numeric n) e (n);   -- expected_check_count (0516: +5, 0518: +1)$b$,
    $m$(select 45::numeric n) e (n);$m$);

  select count(*) into v_after from public.ledger_checks(v_co);
  if v_after <> v_before + 1 then
    raise exception '0518 FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. ASSERTIONS — each one names the failure it can see.
-- ---------------------------------------------------------------------------
do $$
declare
  b        record;
  v_n      numeric;
  v_txt    text;
  v_bad    int;
begin
  select * into b from t0518_before;

  -- 6a. The counting is in, everywhere it is read.
  if position('sum(jl.credit - jl.debit), 0) into v_prior' in pg_get_functiondef('public.release_prepaid_expenses(uuid,date)'::regprocedure)) = 0
  or position('a reversed release does not mark the month done' in pg_get_functiondef('public.release_prepaid_expenses(uuid,date)'::regprocedure)) = 0
  or position('sum(jl.credit - jl.debit) amt' in pg_get_functiondef('public.stale_prepaid_expenses(uuid)'::regprocedure)) = 0
  or position('sum(jl.credit - jl.debit) amt' in pg_get_functiondef('public.prepaid_schedule(uuid)'::regprocedure)) = 0 then
    raise exception '0518 FAILED: a reader of the release balance still counts credits only.';
  end if;
  if current_setting('bastion.prepaid_only_expense', true) is distinct from ''
     and current_setting('bastion.prepaid_only_expense', true) is not null then
    raise exception '0518 FAILED: bastion.prepaid_only_expense was left set.';
  end if;

  -- 6b. Nova: released net 142,515, nothing left on Prepaid from its release.
  select coalesce(sum(jl.credit - jl.debit), 0) into v_n
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    join public.chart_of_accounts a on a.id = jl.account_id and a.system_key = 'prepaid_expenses'
   where je.source_table = 'expenses_prepaid_release' and je.source_id = '2b2f996d-7885-4005-8c96-5898f52ad37f';
  if v_n <> 142515 then raise exception '0518 FAILED: Nova released net % after the correction, expected 142,515.', v_n; end if;

  if b.fresh then
    -- 6c. August's 5900 fell by exactly 30,000 — not by the whole release, not
    --     by nothing.
    select coalesce(sum(jl.debit - jl.credit), 0) into v_n
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = b.co and a.account_code = '5900'
       and je.entry_date between '2026-08-01' and '2026-08-31';
    if v_n <> b.aug_5900 - 30000 then
      raise exception '0518 FAILED: August 5900 moved from % to %, expected a fall of exactly 30,000.', b.aug_5900, v_n;
    end if;

    -- 6d. Exactly two entries were written — one reversal, one release — and
    --     no other expense's releases were touched.
    if (select count(*) from public.journal_entries) <> b.entries + 2 then
      raise exception '0518 FAILED: % journal entries written, expected 2.', (select count(*) from public.journal_entries) - b.entries;
    end if;
    if (select count(*) from public.journal_entries
         where source_table = 'expenses_prepaid_release'
           and source_id <> '2b2f996d-7885-4005-8c96-5898f52ad37f') <> b.other_releases then
      raise exception '0518 FAILED: another expense''s releases changed.';
    end if;

    -- 6e. The two copies of the schedule agree on every expense that has ever
    --     been released. A drift row there means the check and the job
    --     disagree — or a real error this migration did not know about.
    --     Either way it is not applied blind.
    select count(*), string_agg(distinct d.description, '; ') into v_bad, v_txt
      from public.companies c, public.prepaid_schedule_drift(c.id) d
     where exists (select 1 from public.journal_entries je
                    where je.source_table = 'expenses_prepaid_release' and je.source_id = d.expense_id);
    if v_bad > 0 then
      raise exception '0518 FAILED: % drift row(s) on expenses that have been released: %', v_bad, v_txt;
    end if;
  end if;

  -- 6f. The named red set, diffed. Allowed to change: no_stale_prepaid_balance
  --     (falls by one, Nova), prepaid_released_matches_schedule (new),
  --     checks_evaluated (must still pass). Anything else moving is refused —
  --     except the ACTUAL of trial_balance_debits_equal_credits, which is the
  --     gross debit total and moves with any posting (here +315,030: the
  --     reversal and the re-release); its pass/fail must still hold.
  select count(*), string_agg(a.name || ' ' || a.check_name || ' ' || coalesce(o.actual::text, 'new') || '->' || a.actual::text, '; ')
    into v_bad, v_txt
    from (select c.id co, c.name, lc.check_name, lc.actual, lc.passed
            from public.companies c, public.ledger_checks(c.id) lc) a
    left join t0518_red o on o.co = a.co and o.check_name = a.check_name
   where a.check_name not in ('no_stale_prepaid_balance', 'prepaid_released_matches_schedule', 'checks_evaluated')
     and (o.check_name is null
          or o.passed is distinct from a.passed
          or (o.actual is distinct from a.actual and a.check_name <> 'trial_balance_debits_equal_credits'));
  if v_bad > 0 then raise exception '0518 FAILED: an unrelated check moved: %', v_txt; end if;

  if exists (select 1 from public.companies c, public.ledger_checks(c.id) lc
              where lc.check_name = 'checks_evaluated' and not lc.passed) then
    raise exception '0518 FAILED: checks_evaluated disagrees with the number of checks.';
  end if;

  if b.fresh and exists (
       select 1 from public.ledger_checks(b.co) lc join t0518_red o on o.co = b.co and o.check_name = lc.check_name
        where lc.check_name = 'no_stale_prepaid_balance' and lc.actual <> o.actual - 1) then
    raise exception '0518 FAILED: no_stale_prepaid_balance did not fall by exactly one (Nova).';
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
    raise exception '0518 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
