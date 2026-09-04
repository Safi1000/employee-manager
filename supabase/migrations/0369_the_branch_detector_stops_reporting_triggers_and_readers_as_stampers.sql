-- 0367 — branch_guard_gaps() drops the triggers and separates the readers from
--        the stampers. Both refinements were earned by its first run.
--
-- ===========================================================================
-- WHAT THE FIRST RUN GOT WRONG ABOUT ITSELF
-- ===========================================================================
--
-- 47 rows across 44 functions, and two of the categories were the detector's
-- fault rather than the database's:
--
-- 1. EIGHT TRIGGER FUNCTIONS. A trigger fires as a consequence of a write the
--    caller already made and RLS already vetted, and it cannot be called
--    directly at all. It is not an attack surface, and a branch assertion
--    inside one would refuse writes that RLS has already permitted. Reporting
--    them was wrong, not merely noisy.
--
-- 2. NINE PURE READERS reported under a rule written for stampers.
--    avg_deployed_guards, region_profit, ho_apportionment_driver and the rest
--    take a branch and RETURN numbers about it. A branched user learns another
--    region's figures — which is real, and is READ escalation, a different and
--    lesser finding than writing into another region. Filed under "stamps" they
--    were being described as something they are not, and a reader who fixed the
--    nine as if they were writers would have wasted the effort.
--
-- The rule this leaves: A DETECTOR THAT LABELS TWO DIFFERENT FINDINGS WITH ONE
-- WORD IS REPORTING THE WRONG THING ABOUT ONE OF THEM. Splitting them costs one
-- column and makes both actionable.
--
-- ===========================================================================
-- APPLIED BY RESTATEMENT, WHICH IS ALLOWED HERE AND ONLY BECAUSE
-- ===========================================================================
--
-- branch_guard_gaps has exactly ONE author — 0365, yesterday. CLAUDE.md permits
-- restating a single-author function provided the migration first asserts that
-- the body it is replacing is a digest it recognises, and refuses anything else.
-- An unrecognised body would mean a second edit nobody recorded, which is
-- precisely the case where restating destroys something.
--
-- Three separate anchored edits would also have worked. The digest is clearer
-- here because the change touches the CTE list, the projection and the WHERE in
-- one shape.

do $$
declare
  v_digest text;
  a_digest text := 'fefbf6e31445e00346bbc968c9d70182';
begin
  select md5(pg_get_functiondef(p.oid)) into v_digest
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'branch_guard_gaps';

  if v_digest is null then
    raise exception '0367 REFUSED: branch_guard_gaps does not exist.';
  end if;
  if v_digest <> a_digest then
    raise exception
      '0367 REFUSED: branch_guard_gaps is not the body this migration was written against (found %, expected %). Something has edited it since 0365, and restating from here would silently discard that edit.',
      v_digest, a_digest;
  end if;
end $$;

create or replace function public.branch_guard_gaps()
returns table(function_name text, subject text, shape text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with fns as (
    select p.oid, p.proname::text as fname, p.prosrc,
           p.proargnames, p.proargtypes, p.provolatile,
           pg_get_function_identity_arguments(p.oid) as fargs
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef                       -- invoker functions get branch_scope for free
       -- 0367: TRIGGERS ARE NOT AN ATTACK SURFACE. A trigger fires because a
       -- write already passed RLS, and cannot be invoked directly. A branch
       -- assertion inside one would refuse writes the policies allowed.
       and p.prorettype <> 'trigger'::regtype
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and p.proname not in ('assert_same_company', 'assert_branch_in_company',
                             'same_company_branch', 'assert_branch_writable',
                             'branch_guard_gaps', 'branch_guard_covered',
                             'branch_scoped_tables')
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
  -- ARM B: accepts a uuid parameter that names a branch. Volatility separates
  -- the two findings hiding in here — a writer STAMPS the branch onto a row, a
  -- stable function only READS about it.
  params as (
    select f.fname, u.name as param, f.prosrc, f.provolatile
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
  select p.fname, p.param,
         case when p.provolatile = 'v' then 'stamps' else 'reads' end,
         case when p.provolatile = 'v'
              then 'SECURITY DEFINER function accepts ' || p.param ||
                   ' and never checks it against the caller''s own branch. The company is not the boundary here — a branched user can hand it another region''s branch and write into that region.'
              else 'SECURITY DEFINER READER accepts ' || p.param ||
                   ' and never checks it against the caller''s own branch. Nothing is written; a branched user learns another region''s figures. Read escalation — real, lesser, and a separate decision from the write cases.'
         end
    from params p
   where not public.branch_guard_covered(p.prosrc)
   order by 3, 1, 2;
$fn$;

comment on function public.branch_guard_gaps() is
  '0365/0367: SECURITY DEFINER functions that cross the branch boundary without referencing it. Three shapes: writes (writes a branch_scope table), stamps (volatile, accepts a branch id it never checks — writes into another region), reads (stable, accepts a branch id it never checks — learns another region''s figures, a lesser and separate finding). Trigger functions are excluded: a trigger fires because a write already passed RLS and cannot be called directly. Still blind to transitive writes, dynamic SQL, and guards that are present but wrong.';

revoke execute on function public.branch_guard_gaps() from public, anon;
grant execute on function public.branch_guard_gaps() to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE THE REFINEMENTS DID WHAT THEY CLAIM, in both directions. A detector
-- that quietly stopped matching would show the same "fewer rows" as one that
-- correctly narrowed.
-- ---------------------------------------------------------------------------
do $$
declare
  v_trigger int;
  v_reads   int;
  v_stamps  int;
  v_writes  int;
begin
  -- 1. No trigger function survives.
  select count(*) into v_trigger
    from public.branch_guard_gaps() g
    join pg_proc p on p.proname = g.function_name and p.pronamespace = 'public'::regnamespace
   where p.prorettype = 'trigger'::regtype;
  if v_trigger <> 0 then
    raise exception '0367 FAILED: % trigger function(s) still reported.', v_trigger;
  end if;

  -- 2. The readers are still reported, but as readers.
  select count(*) into v_reads from public.branch_guard_gaps() where shape = 'reads';
  if v_reads = 0 then
    raise exception
      '0367 FAILED: no rows came back with shape=reads. The nine readers were meant to be RELABELLED, not dropped — losing them would be a detector that stopped matching.';
  end if;

  -- 3. Arm A still finds the live defect it was proved against in 0365.
  select count(*) into v_writes from public.branch_guard_gaps()
   where function_name = 'record_invoice_payment' and shape = 'writes';
  if v_writes = 0 then
    raise exception '0367 FAILED: arm A no longer flags record_invoice_payment.';
  end if;

  select count(*) into v_stamps from public.branch_guard_gaps() where shape = 'stamps';

  raise notice '0367: writes/stamps/reads now %/%/% and no triggers.',
    (select count(*) from public.branch_guard_gaps() where shape = 'writes'),
    v_stamps, v_reads;
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
    raise exception '0367 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
