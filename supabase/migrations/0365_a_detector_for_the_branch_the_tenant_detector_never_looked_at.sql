-- 0365 — branch_guard_gaps(): the detector for the boundary tenant_guard_gaps()
--        has never looked at.
--
-- NOT WIRED INTO ledger_checks BY THIS MIGRATION. It is deployed so its first
-- run can be READ, because a detector's first run is a survey and not yet a
-- verdict — some of what it finds will be company-wide jobs that are correct to
-- have no branch assertion, and those need naming as exemptions before a red
-- means anything. Wiring it in behind an unexamined result would ship a check
-- that is red on day one, which teaches people to ignore reds.
--
-- ===========================================================================
-- WHY THIS EXISTS
-- ===========================================================================
--
-- tenant_guard_gaps() inspects SECURITY DEFINER functions for uuid parameters
-- that name a tenant-scoped row and are not covered by assert_same_company.
-- It has never once looked at the BRANCH. So the four definer RPCs could each
-- pass every tenant check while reaching straight past branch_scope, and did.
--
-- Fixing record_invoice_payment and post_manual_journal closes two functions.
-- It does not stop the third being written next week. This does.
--
-- ===========================================================================
-- TWO ARMS, BECAUSE ONE TEST MISSES HALF THE DEFECT
-- ===========================================================================
--
-- The obvious detector is "a definer function that WRITES a branch_scope table
-- without asserting the branch". That arm catches record_invoice_payment, which
-- writes invoices and invoice_payments.
--
-- IT DOES NOT CATCH post_manual_journal, and that is worth saying plainly
-- because a one-armed detector would have been shipped believing it covered
-- both. post_manual_journal writes no branch_scope table at all — it writes
-- journal_entries and journal_lines through post_journal, and neither carries
-- branch_scope. Its defect is the other shape: it ACCEPTS a branch id and
-- stamps it onto a row, validating only that the branch belongs to the same
-- company. A branched user hands it another region's branch and the entry lands
-- in that region's P&L.
--
--   ARM A — writes a branch_scope table, no branch predicate in the body.
--   ARM B — takes a uuid parameter naming a branch, no branch predicate.
--
-- Same distinction the tenant detector draws between [claimed] and [resolved],
-- arrived at from the other direction.
--
-- ===========================================================================
-- WHAT IT CANNOT SEE, STATED UP FRONT
-- ===========================================================================
--
-- It reads prosrc as TEXT, exactly as tenant_guard_covered() does, and it is
-- therefore blind in the same three ways:
--
--   * TRANSITIVE WRITES. A definer function that calls a second function which
--     writes a branch_scope table is invisible to arm A. The tenant detector
--     has the same hole and 0305 papered over one instance of it by teaching
--     the matcher a second spelling rather than by following calls.
--   * DYNAMIC SQL. `execute 'update ' || t` writes a table this cannot name.
--   * A GUARD THAT IS PRESENT BUT WRONG. Mentioning current_branch_id() counts
--     as covered. The detector proves somebody thought about the branch, not
--     that they thought correctly — the same contract tenant_guard_covered()
--     offers, and the reason both are a floor rather than a ceiling.
--
-- Saying this here so the first person to trust it further than it goes has
-- been told.

-- ---------------------------------------------------------------------------
-- The twelve tables, read from the catalogue rather than listed.
--
-- A LIST WOULD ROT. branch_scope is added to new tables as the regional model
-- grows, and a hardcoded array would silently stop covering them — which is the
-- failure mode of every "list of things to check" in this project. pg_policies
-- already knows the answer.
-- ---------------------------------------------------------------------------
create or replace function public.branch_scoped_tables()
returns table(table_name text)
language sql
stable
as $fn$
  select p.tablename::text
    from pg_policies p
   where p.schemaname = 'public' and p.policyname = 'branch_scope'
   order by 1;
$fn$;

comment on function public.branch_scoped_tables() is
  '0365: the tables carrying a branch_scope policy, read from pg_policies rather than listed. A hardcoded list would stop covering tables added later, which is how every checklist in this project has failed.';

-- ---------------------------------------------------------------------------
-- "Covered" means the body mentions the branch at all.
--
-- Deliberately generous, and the same contract tenant_guard_covered() offers:
-- it proves somebody considered the branch, not that they considered it
-- correctly. A stricter matcher would report the careful functions and the
-- careless ones identically, which is worse than a floor.
-- ---------------------------------------------------------------------------
create or replace function public.branch_guard_covered(p_src text)
returns boolean
language sql
immutable
as $fn$
  -- same_company_branch() is DELIBERATELY ABSENT from this list. It checks that
  -- a branch belongs to the same COMPANY, which is the tenant boundary and not
  -- the branch one — it is precisely post_manual_journal's defect wearing a
  -- helper's name. Counting it as coverage would clear the functions most
  -- likely to be wrong.
  select public.executable_source(p_src) ~ 'assert_branch_writable\s*\('
      or public.executable_source(p_src) ~ 'current_branch_id\s*\('
      or public.executable_source(p_src) ~ 'is_branched_user\s*\(';
$fn$;

comment on function public.branch_guard_covered(text) is
  '0365: true when a function body references the branch boundary at all — assert_branch_writable, current_branch_id or is_branched_user. NOT same_company_branch, which checks the company and not the branch. Generous on purpose: it proves the branch was considered, not that it was considered correctly. Mirrors tenant_guard_covered().';

-- ---------------------------------------------------------------------------
-- The detector.
-- ---------------------------------------------------------------------------
create or replace function public.branch_guard_gaps()
returns table(function_name text, subject text, shape text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with fns as (
    select p.oid, p.proname::text as fname, p.prosrc,
           p.proargnames, p.proargtypes,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef                       -- invoker functions get branch_scope for free
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and p.proname not in ('assert_same_company', 'assert_branch_in_company',
                             'same_company_branch', 'branch_guard_gaps',
                             'branch_guard_covered', 'branch_scoped_tables')
       and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'BRANCH GUARD EXEMPT%'
  ),
  -- ARM A: writes a table that carries branch_scope.
  writes as (
    select f.fname, t.table_name, f.prosrc
      from fns f
      join public.branch_scoped_tables() t
        on public.executable_source(f.prosrc) ~*
           ('(insert\s+into|update|delete\s+from)\s+(public\.)?' || t.table_name || '\M')
  ),
  -- ARM B: accepts a uuid parameter that names a branch.
  params as (
    select f.fname, u.name as param, f.prosrc
      from fns f,
           lateral unnest(f.proargnames[1:array_length(f.proargtypes, 1)], f.proargtypes)
             with ordinality as u(name, typ, ord)
     where u.typ = 'uuid'::regtype::oid
       and u.name ~* 'branch'
  )
  select w.fname, w.table_name, 'writes'::text,
         'SECURITY DEFINER function writes ' || w.table_name ||
         ', which carries branch_scope, without referencing the branch boundary. A definer body is not subject to the caller''s policies, so branch_scope is off for the whole call.'
    from writes w
   where not public.branch_guard_covered(w.prosrc)
  union all
  select p.fname, p.param, 'stamps'::text,
         'SECURITY DEFINER function accepts ' || p.param ||
         ' and never checks it against the caller''s own branch. The company is not the boundary here — a branched user can hand it another region''s branch.'
    from params p
   where not public.branch_guard_covered(p.prosrc)
   order by 1, 3, 2;
$fn$;

comment on function public.branch_guard_gaps() is
  '0365: SECURITY DEFINER functions that cross the branch boundary without referencing it — either by WRITING a branch_scope table (shape=writes) or by ACCEPTING a branch id they never check against the caller''s own (shape=stamps). tenant_guard_gaps() has never looked at the branch at all, which is how four RPCs passed every tenant check while reaching past branch_scope. NOT yet wired into ledger_checks: its first run is a survey, and the company-wide jobs it legitimately finds need exempting by name first. Blind to transitive writes, dynamic SQL, and guards that are present but wrong.';

revoke execute on function public.branch_guard_gaps() from public, anon;
grant execute on function public.branch_guard_gaps() to authenticated;
revoke execute on function public.branch_scoped_tables() from public, anon;
grant execute on function public.branch_scoped_tables() to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE THE DETECTOR DETECTS. A detector that returns an empty set because its
-- regex never matches is indistinguishable from a clean database, and that is
-- exactly how ledger_foundation.sql sat dead from 0224 onward.
--
-- Both arms are asserted against a known-bad function that exists right now.
-- When record_invoice_payment and post_manual_journal are fixed, THIS PROBE IS
-- SUPPOSED TO FAIL on re-run — and that is the correct signal to replace it
-- with a synthetic fixture, not to delete it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_writes int;
  v_stamps int;
  v_total  int;
begin
  select count(*) into v_writes from public.branch_guard_gaps()
   where function_name = 'record_invoice_payment' and shape = 'writes';
  select count(*) into v_stamps from public.branch_guard_gaps()
   where function_name = 'post_manual_journal' and shape = 'stamps';
  select count(*) into v_total from public.branch_guard_gaps();

  if v_writes = 0 then
    raise exception
      '0365 FAILED: arm A did not flag record_invoice_payment, which writes invoice_payments and invoices and references the branch nowhere. The write regex matches nothing.';
  end if;
  if v_stamps = 0 then
    raise exception
      '0365 FAILED: arm B did not flag post_manual_journal, which takes p_branch_id and checks it against the company only. The parameter arm matches nothing.';
  end if;

  raise notice '0365: branch_guard_gaps() reports % row(s); both arms proved against live defects.', v_total;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0365 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
