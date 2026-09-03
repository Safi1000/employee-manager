-- 0348 — 0347 and 0345 left two checks red. This is the correction.
--
-- Both regressions were introduced by migrations applied minutes earlier, both
-- were caught by the check suite doing exactly its job, and both are stated
-- here rather than quietly repaired, because a migration that fixes its
-- predecessor's mistake without naming it teaches the next reader that the
-- predecessor was right.
--
-- ---------------------------------------------------------------------------
-- REGRESSION 1 — checks_evaluated: expected 30, actual 31.
--
-- 0347 added `no_stale_prepaid_balance` to ledger_checks and did NOT raise the
-- expected count. Worse, it carried a comment asserting that raising it was
-- unnecessary because "the new check lives in ledger_checks, not the base".
-- That reasoning was WRONG. The canary counts the rows ledger_checks returns —
-- `(select count(*) from real_checks)` — and real_checks is the union of the
-- base AND every arm added in the wrapper. 0347's check is one of those arms.
--
-- The canary's own comment says what to do and 0347 should have read it:
--
--     raise it deliberately when adding a check. Never to make this row green.
--
-- This raise is deliberate, and it accompanies a check that genuinely exists.
-- 30 -> 31.
--
-- ---------------------------------------------------------------------------
-- REGRESSION 2 — tenant_guard_covers_every_parameter: expected 0, actual 2.
--
-- Two functions were shipped with a tenant-scoped uuid parameter and no guard:
--
--   stale_prepaid_expenses(p_company_id)     [claimed]  — 0347
--   retire_orphaned_leaf_account(p_account_id) [resolved] — 0345
--
-- These are not cosmetic. stale_prepaid_expenses is granted to `authenticated`
-- and takes a company id straight from the caller: without the guard, any
-- signed-in user could read another company's prepaid schedule — amounts,
-- descriptions and dates — by passing a different uuid. That is a cross-tenant
-- read, and the check existing is the only reason it was caught within minutes
-- rather than never.
--
-- retire_orphaned_leaf_account is the milder of the two — it is called only
-- from a trigger with OLD.coa_account_id, and every branch it takes is a no-op
-- unless the account is genuinely unowned — but 0345 ASSERTED in a comment that
-- it needed no guard, and an argued exemption is exactly the kind that stops
-- being true when the next caller appears. It takes the [resolved] shape: the
-- owning company is looked up from the account itself.

-- ---------------------------------------------------------------------------
-- Fix 2a. The claimed guard: the caller hands over a company id, so it is
-- checked against the caller's own tenant.
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
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
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
end;
$fn$;

comment on function public.stale_prepaid_expenses(uuid) is
  '0347/0348: prepaid expenses whose coverage period has fully passed and that still carry an unreleased balance in 1160. Non-empty means the release run stopped — the failure mode whose symptom is silence. Tenant-guarded [claimed] since 0348; it is granted to authenticated and 0347 shipped it without one.';

revoke execute on function public.stale_prepaid_expenses(uuid) from public, anon;
grant execute on function public.stale_prepaid_expenses(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Fix 2b. The resolved guard: the company is looked up from the account.
-- ---------------------------------------------------------------------------
create or replace function public.retire_orphaned_leaf_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_lines int;
  v_code  text;
begin
  if p_account_id is null then return; end if;

  -- tenant guard [resolved]: owning company looked up from p_account_id via
  -- public.chart_of_accounts. 0345 argued this function needed no guard because
  -- it is only ever reached from a trigger on a row the caller just deleted.
  -- That argument was about the CURRENT caller, and the guard has to hold for
  -- the next one too.
  perform public.assert_same_company(
    (select company_id from public.chart_of_accounts where id = p_account_id));

  select count(*) into v_lines from public.journal_lines where account_id = p_account_id;

  -- Has held a line: it survives, active and untouched. This is the whole
  -- point of the rule and it is checked first.
  if v_lines > 0 then return; end if;

  -- Still owned by something else (a partner and a cash location can, in
  -- principle, point at the same account). Not an orphan.
  if exists (select 1 from public.partners       where coa_account_id = p_account_id)
  or exists (select 1 from public.cash_locations where coa_account_id = p_account_id) then
    return;
  end if;

  update public.chart_of_accounts
     set active = false,
         notes  = coalesce(notes || ' | ', '') ||
                  'Retired ' || to_char(now(), 'YYYY-MM-DD') ||
                  ': owning record deleted, account never held a journal line (0345).'
   where id = p_account_id and active
   returning account_code into v_code;

  if v_code is not null then
    raise notice '0345: retired orphaned leaf account %', v_code;
  end if;
end;
$fn$;

comment on function public.retire_orphaned_leaf_account(uuid) is
  '0345/0348: deactivates an auto-created leaf account whose owning partner / bank account / cash location has been deleted, PROVIDED it has never held a journal line. An account with history is left active and untouched. Tenant-guarded [resolved] since 0348 — 0345 argued an exemption, and an argued exemption stops being true when the next caller appears.';

-- ---------------------------------------------------------------------------
-- Fix 1. The canary. Surgery with an anchor asserted to appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := '(select 30::numeric n) e (n);   -- expected_check_count';
  v_new    text;
  v_hits   int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0348 REFUSED: public.ledger_checks does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0348 REFUSED: the expected_check_count anchor appears % time(s), expected 1.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor, '(select 31::numeric n) e (n);   -- expected_check_count');
  execute v_new;
  raise notice '0348: expected_check_count 30 -> 31.';
end $$;

-- ---------------------------------------------------------------------------
-- Both regressions must actually be gone. This is the whole point of the file.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_gaps  int;
  v_canary record;
begin
  select count(*) into v_gaps from public.tenant_guard_gaps();
  if v_gaps <> 0 then
    raise exception '0348 FAILED: % tenant guard gap(s) remain. 0345 and 0347 each shipped one and this file exists to close both.', v_gaps;
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  if v_co is not null then
    select * into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
    if not v_canary.passed then
      raise exception '0348 FAILED: checks_evaluated still red — expected %, actual %. The canary counts every arm of ledger_checks, base and wrapper alike.',
        v_canary.expected, v_canary.actual;
    end if;
    raise notice '0348: canary green at % checks; 0 tenant guard gaps.', v_canary.actual;
  end if;
end $$;
