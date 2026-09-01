-- 0288b — uninvoked_controls() counted MENTIONS, not CALLS, and exonerated the
-- one function it was written to expose.
--
-- DEV ONLY. Fixes a defect shipped minutes earlier in 0288.
--
-- WHAT HAPPENED
--
-- 0288's header states, at length, that ledger_checks is deliberately NOT
-- exempt because it is the sharpest instance and must stay visible. Then the
-- check reported six functions and ledger_checks was not among them.
--
-- The cause is the check's own documentation. Reachability was computed as
--
--   q.prosrc ~ ('\m' || fname || '\M')
--
-- and `uninvoked_controls` contains, inside its exempt list, the comment text
-- "It is invoked by ledger_checks(); listing itself would be noise." That
-- sentence is part of prosrc. So the check found the string `ledger_checks`
-- inside a function body, concluded something called it, and cleared it.
--
-- A CHECK THAT WAS FOOLED BY ITS OWN PROSE ABOUT THE THING IT WAS CHECKING.
--
-- WHY THIS IS THE THIRD INSTANCE, NOT THE FIRST
--
-- "A mention is not a check" is already written twice in this codebase:
--
--   * the original audit filtered on `prosrc not ilike '%company_id%'` and
--     called post_journal tenant-aware because it mentions company_id eleven
--     times without ever comparing it;
--   * 0242 filtered on `prosrc not ilike '%current_company_id%'` and skipped
--     two functions for the same reason, which 0242b had to repair.
--
-- Both are recorded in 0242b's header as the same class of mistake. This is
-- that class a third time, in a function written by someone who had just read
-- both. Substring matching on source text answers "does this word appear",
-- which is not the question anybody ever means.
--
-- AND IT FAILED IN THE MORE DANGEROUS DIRECTION
--
-- §9.6 now carries two rules: a check that never runs is indistinguishable
-- from one that always passes, and a check reporting a problem must itself be
-- verified before the problem is acted on. This is a third shape — the check
-- ran, was believed, and returned a FALSE NEGATIVE. It did not fail loudly like
-- a false positive, and it did not sit silent like a check nobody calls. It
-- answered confidently and wrongly, and the answer was reassuring.
--
-- 0288's own verification passed because it asserted the five known-dead
-- functions were reported and never asserted that ledger_checks was. It tested
-- what was expected to be true instead of the claim the header made. The
-- verification below asserts the claim.
--
-- THE FIX
--
-- Two changes, both narrowing "mention" toward "call":
--
--   1. Strip `--` comments from prosrc before matching. Prose about a function
--      is not an invocation of it. This is the same correction the migration
--      audit needed when its comment-stripper counted a trailing comment as
--      executable text — the instrument has to know which bytes run.
--   2. Require call syntax: the name followed by optional whitespace and `(`.
--      A bare word is not an invocation either.
--
-- Neither is perfect — a name inside a string literal still reads as a call,
-- and dynamic SQL that builds a name at runtime still reads as nothing. Both
-- are stated here rather than discovered later.

create or replace function public.uninvoked_controls()
returns table(function_name text, args text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cand as (
    select p.oid, p.proname::text as fname,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname::text ~ '(gap|check|drift|residue|blocker|completeness|missing|breach|discrepanc|orphan|mismatch|unposted|over_allocated|negative_|invalid|stale|unbalanced|anomal)'
            or (p.proretset and p.proname::text ~ '(_rows|_balances|_held_|_review)'))
       and p.prorettype <> 'trigger'::regtype
  ),
  -- 0288b. Comments are not code. Strip them before asking what calls what.
  src as (
    select q.oid, regexp_replace(q.prosrc, '--[^\n]*', '', 'g') as code
      from pg_proc q where q.pronamespace = 'public'::regnamespace
  ),
  exempt as (
    select * from (values
      ('armed_post_blockers',
       'CALLED BY THE APPLICATION. This check cannot see src/.'),
      ('sweep_ammo_discrepancy_alerts',
       'CALLED BY THE APPLICATION. This check cannot see src/.'),
      ('uninvoked_controls',
       'THIS FUNCTION. Invoked by the ledger check suite; listing itself would be noise.')
    ) as t(fname, why)
  ),
  reach as (
    select c.oid, c.fname, c.fargs,
           -- CALL syntax, in code with comments removed.
           (select count(*) from src s
             where s.oid <> c.oid and s.code ~ ('\m'||c.fname||'\s*\('))              as by_fn,
           (select count(*) from pg_views v
             where v.schemaname='public' and v.definition ~ ('\m'||c.fname||'\s*\(')) as by_view,
           (select count(*) from pg_policy pol
             where pg_get_expr(pol.polqual, pol.polrelid) ~ ('\m'||c.fname||'\s*\(')
                or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid),'') ~ ('\m'||c.fname||'\s*\(')) as by_policy,
           (select count(*) from pg_constraint k
             where k.contype='c' and pg_get_constraintdef(k.oid) ~ ('\m'||c.fname||'\s*\(')) as by_check,
           (select count(*) from pg_index i
             where pg_get_indexdef(i.indexrelid) ~ ('\m'||c.fname||'\s*\('))          as by_index,
           (select count(*) from pg_attrdef d
             where pg_get_expr(d.adbin, d.adrelid) ~ ('\m'||c.fname||'\s*\('))        as by_default,
           (select count(*) from pg_trigger t where not t.tgisinternal and t.tgfoid = c.oid) as by_trigger,
           (select count(*) from cron.job j where j.active and j.command ~ ('\m'||c.fname||'\s*\(')) as by_cron
      from cand c
  )
  select r.fname, r.fargs,
         'no function, view, policy, constraint, index, default, trigger or cron job CALLS it'
    from reach r
   where r.by_fn + r.by_view + r.by_policy + r.by_check
       + r.by_index + r.by_default + r.by_trigger + r.by_cron = 0
     and not exists (select 1 from exempt e where e.fname = r.fname)
   order by 1;
$function$;

comment on function public.uninvoked_controls() is
  'Check-shaped functions that nothing inside the database CALLS and no cron job runs. Matches call syntax in comment-stripped source, because a mention is not a call — 0288 counted mentions and was fooled by its own comment into clearing ledger_checks. Cannot see the application; application-invoked controls are exempt by name. See 0288b.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare v_before int; v_after int;
    begin
      -- THE CLAIM 0288's HEADER MADE AND ITS VERIFICATION NEVER TESTED.
      if not exists (select 1 from public.uninvoked_controls()
                      where function_name = 'ledger_checks') then
        raise exception '0288b FAILED: ledger_checks is still not reported — nothing calls it and no cron job runs it, so it must appear';
      end if;

      -- The five known-dead are still reported: the narrowing must not have
      -- traded one blind spot for another.
      if (select count(*) from public.uninvoked_controls()
           where function_name in ('bonus_accrual_missing','check_deploy_guard',
                                   'check_disbursement','first_breach_week',
                                   'profit_allocation_review')) <> 5 then
        raise exception '0288b FAILED: the five known-uninvoked controls are not all reported';
      end if;

      -- A genuinely called control must NOT be reported. tenant_guard_gaps is
      -- called by the ledger suite; if the narrowing broke real detection this
      -- is where it shows.
      if exists (select 1 from public.uninvoked_controls()
                  where function_name = 'tenant_guard_gaps') then
        raise exception '0288b FAILED: tenant_guard_gaps is called by ledger_checks but was reported as uninvoked';
      end if;

      -- SENSITIVITY, and specifically that a COMMENT does not count as a call.
      select count(*) into v_before from public.uninvoked_controls();
      execute 'create function public._probe_orphan_check() returns integer language sql stable as $p$ select 1 $p$';
      execute 'create function public._probe_mentioner() returns integer language sql stable as $p$ -- _probe_orphan_check() is only named in this comment
        select 2 $p$';
      select count(*) into v_after from public.uninvoked_controls();
      if not exists (select 1 from public.uninvoked_controls()
                      where function_name = '_probe_orphan_check') then
        raise exception 'PROBE FAILED: a comment mentioning the function was counted as a call';
      end if;
      if v_after <> v_before + 1 then
        raise exception 'PROBE FAILED: expected exactly one new uninvoked control, count went % -> %',
          v_before, v_after;
      end if;
      execute 'drop function public._probe_mentioner()';
      execute 'drop function public._probe_orphan_check()';

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0288b verification failed: %', v_outcome;
  end if;
end
$verify$;
