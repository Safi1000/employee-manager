-- 0522 — A cost entered after the cutover whose own period falls before it
-- adjusts the opening: its pre-cutover share posts to Opening Balance Equity,
-- dated after the cutover, and never into a pre-cutover month.
--
-- NUMBER: written as 0522 on 2026-10-17. Claim it against
-- supabase_migrations.schema_migrations at apply time; rename the FILE if taken.
-- NEEDS 0519 (ledger_cutover_date). Independent of 0520 and 0521.
--
-- ===========================================================================
-- THE RULE, AND WHY IT IS A RULE AT POSTING TIME RATHER THAN A BATCH LINE
-- ===========================================================================
-- Any document dated after the cutover whose cost, by its own period, falls on
-- or before it, posts that share against the opening — Dr 3200 Opening Balance
-- Equity — dated after the cutover, instead of into a month the GL no longer
-- itemises. It is a prior-period adjustment of the opening, the standard
-- treatment.
--
-- Done at posting time, not as lines in the opening batch, because a batch line
-- can only carry what is known on the day the batch posts. A July bill entered
-- in December has no batch line to clear; under this rule it needs none. The
-- three known cases need no special lines either:
--   * "till september 43,000" (service 1 Jul–30 Sep, paid 15 Oct): the release
--     schedule's July and August shares, 14,489.13 each, post Dr 3200 / Cr 1160
--     dated 15 Oct; September posts normally. THIS migration.
--   * PESSI Taxila July–August 132,000 and the August employer EOBI 193,210:
--     both are statutory payments for pre-cutover months; the remittance action
--     (0520) sends their unaccrued remainder to 3200 by the same rule. They are
--     converted when the user's challans arrive.
--
-- WHAT IT CHANGES IN THE BATCH. The draft cutover batch carried Cr 1160
-- 359,419.53 for the August releases of Rent, Emaar and Nova. Under this rule
-- those are carries too: when the cutover archives the 31 Aug releases, the
-- next release run re-posts their August shares as carries. So that batch line
-- comes OUT, or 1160 would be credited twice. The batch file says so.
--
-- ===========================================================================
-- THE MECHANISM, IN release_prepaid_expenses (surgery; four authors)
-- ===========================================================================
-- For a month on or before the cutover month, the release posts:
--   Dr 3200 opening_balance_equity   (instead of the expense account)
--   Cr 1160 prepaid_expenses
--   dated greatest(cutover + 1, the expense's own date)   (instead of month end)
-- and records the month it covers in prepaid_carry_months, because a carry is
-- not dated in that month. "A month is done" therefore means: a live release
-- dated in that month that is not a carry, OR a live carry that covers it.
-- Until the cutover posts, the existing 31 Aug releases still mark August done,
-- so nothing is carried twice before the archive.
--
-- Because a carry is still source_table 'expenses_prepaid_release', every
-- reader of the released balance (the job's catch-up, its final-month
-- remainder, stale_prepaid_expenses, prepaid_schedule, prepaid_reschedule from
-- 0518) counts it without change. prepaid_schedule_drift (0518) maps a carry to
-- the month it covers.
--
-- OUTSIDE THIS RULE, said so it is not assumed covered: a payslip for a
-- pre-cutover month created later (the Lahore payroll backfill) still accrues
-- into its own month; once July and August are closed at the cutover, the
-- period lock refuses it. That case needs its own decision when the backfill
-- comes. A late invoice for a pre-cutover service month is revenue, not cost,
-- and is not covered either.
--
-- 1 NOVEMBER 2026 02:20. The monthly run releases "till september 43,000". With
-- this applied, July and August are carried to 3200 and nothing lands in a
-- pre-cutover month. Without it, they post into 31 Jul and 31 Aug.

do $$
begin
  if to_regprocedure('public.ledger_cutover_date(uuid)') is null then
    raise exception '0522 REFUSED: ledger_cutover_date() does not exist. Apply 0519 (the cutover date setting) first.';
  end if;
  if to_regprocedure('public.prepaid_schedule_drift(uuid)') is null then
    raise exception '0522 REFUSED: prepaid_schedule_drift() does not exist. 0518 is expected to be applied.';
  end if;
end $$;

create temp table t0522_red on commit drop as
select c.id co, c.name, lc.check_name, lc.actual, lc.passed
  from public.companies c, public.ledger_checks(c.id) lc;

create table if not exists public.prepaid_carry_months (
  journal_entry_id uuid primary key references public.journal_entries(id),
  company_id       uuid not null references public.companies(id),
  expense_id       uuid not null,
  covered_month    date not null check (covered_month = date_trunc('month', covered_month)::date),
  created_at       timestamptz not null default now()
);
create index if not exists prepaid_carry_months_expense on public.prepaid_carry_months (expense_id, covered_month);

alter table public.prepaid_carry_months enable row level security;
drop policy if exists company_members_read on public.prepaid_carry_months;
create policy company_members_read on public.prepaid_carry_months
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.prepaid_carry_months;
create policy ssa_read on public.prepaid_carry_months
  for select using ((select public.is_ssa_unscoped()));

comment on table public.prepaid_carry_months is
  '0522. Which pre-cutover month a carry entry covers. A carry posts the pre-cutover share of a late expense to Opening Balance Equity dated after the cutover, so its own date does not say which month it covers. Written only by release_prepaid_expenses.';

create or replace function pg_temp.surg0522(p_fn text, p_key text, p_old text, p_new text, p_marker text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_marker in v_def) > 0 then
    raise notice '0522: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0522 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

-- ---------------------------------------------------------------------------
-- 1. release_prepaid_expenses. Each step leaves the function valid on its own.
-- ---------------------------------------------------------------------------
select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$decl$k$,
  $a$-- 0518: one expense, set only by prepaid_reschedule$a$,
  $b$-- 0518: one expense, set only by prepaid_reschedule
  v_cut        date := public.ledger_cutover_date(p_company_id);  -- 0522
  v_carry_mode boolean := false;                                   -- 0522: this month is on or before the cutover
  v_entry      uuid;                                               -- 0522$b$,
  $m$v_carry_mode boolean := false;$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$mode$k$,
  $a$  v_m_end := (v_month + interval '1 month - 1 day')::date;$a$,
  $b$  v_m_end := (v_month + interval '1 month - 1 day')::date;
  v_carry_mode := v_cut is not null and v_month <= date_trunc('month', v_cut)::date;  -- 0522$b$,
  $m$v_carry_mode := v_cut is not null and v_month <= date_trunc('month', v_cut)::date;$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$done$k$,
  $a$            and date_trunc('month', je.entry_date)::date = v_month$a$,
  $b$            and ((date_trunc('month', je.entry_date)::date = v_month
                  and not exists (select 1 from public.prepaid_carry_months pc where pc.journal_entry_id = je.id))
                 or exists (select 1 from public.prepaid_carry_months pc
                             where pc.journal_entry_id = je.id and pc.covered_month = v_month))  /* 0522: a carry marks the month it covers */$b$,
  $m$/* 0522: a carry marks the month it covers */$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$capture$k$,
  $a$    perform public.post_journal($a$,
  $b$    v_entry := public.post_journal(  -- 0522: the id is kept, a carry records its month$b$,
  $m$v_entry := public.post_journal(  -- 0522$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$date$k$,
  $a$      v_m_end,$a$,
  $b$      case when v_carry_mode then greatest(v_cut + 1, r.expense_date) else v_m_end end,  -- 0522: a carry is dated after the cutover$b$,
  $m$-- 0522: a carry is dated after the cutover$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$key$k$,
  $a$        jsonb_build_object('key', v_key,              'debit', v_amount, 'credit', 0),$a$,
  $b$        jsonb_build_object('key', case when v_carry_mode then 'opening_balance_equity' else v_key end,  -- 0522: a carry adjusts the opening
                           'debit', v_amount, 'credit', 0),$b$,
  $m$-- 0522: a carry adjusts the opening$m$);

select pg_temp.surg0522($f$public.release_prepaid_expenses(uuid,date)$f$, $k$record$k$,
  $a$    v_posted := v_posted + 1;$a$,
  $b$    if v_carry_mode then   -- 0522: record the month the carry covers
      insert into public.prepaid_carry_months (journal_entry_id, company_id, expense_id, covered_month)
      values (v_entry, r.company_id, r.id, v_month);
    end if;
    v_posted := v_posted + 1;$b$,
  $m$-- 0522: record the month the carry covers$m$);

-- ---------------------------------------------------------------------------
-- 2. prepaid_schedule_drift: a carry counts toward the month it covers.
-- ---------------------------------------------------------------------------
select pg_temp.surg0522($f$public.prepaid_schedule_drift(uuid)$f$, $k$drift_month$k$,
  $a$    select je.source_id, date_trunc('month', je.entry_date)::date m,$a$,
  $b$    select je.source_id,
           coalesce((select pc.covered_month from public.prepaid_carry_months pc
                      where pc.journal_entry_id in (je.id, je.reversal_of_entry_id) limit 1),
                    date_trunc('month', je.entry_date)::date) m,  -- 0522: a carry counts toward the month it covers$b$,
  $m$-- 0522: a carry counts toward the month it covers$m$);

-- ---------------------------------------------------------------------------
-- 3. ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare v_def text; v_bad int; v_txt text;
begin
  v_def := pg_get_functiondef('public.release_prepaid_expenses(uuid,date)'::regprocedure);
  if position('0522: a carry adjusts the opening' in v_def) = 0
  or position('0522: a carry is dated after the cutover' in v_def) = 0
  or position('0522: a carry marks the month it covers' in v_def) = 0
  or position('0522: record the month the carry covers' in v_def) = 0 then
    raise exception '0522 FAILED: release_prepaid_expenses is missing part of the carry rule.';
  end if;
  -- 0518's counting is still there: a carry does not undo it.
  if position('a reversed release does not mark the month done' in v_def) = 0 then
    raise exception '0522 FAILED: 0518''s counting was lost from release_prepaid_expenses.';
  end if;
  if exists (select 1 from public.prepaid_carry_months) then
    raise exception '0522 FAILED: carries exist already; this migration posts none.';
  end if;

  -- Nothing posts here, so no check may move.
  select count(*), string_agg(a.name || ' ' || a.check_name || ' ' || coalesce(o.actual::text, 'new') || '->' || a.actual::text, '; ')
    into v_bad, v_txt
    from (select c.id co, c.name, lc.check_name, lc.actual, lc.passed
            from public.companies c, public.ledger_checks(c.id) lc) a
    left join t0522_red o on o.co = a.co and o.check_name = a.check_name
   where o.check_name is null or o.passed is distinct from a.passed or o.actual is distinct from a.actual;
  if v_bad > 0 then raise exception '0522 FAILED: a check moved: %', v_txt; end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0522 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
