-- 0403 — a converted function still needs a GRANT on what it writes.
--
-- SEPARATION HAS BEEN IMPOSSIBLE FOR EVERY USER SINCE 2026-09-04 03:07 UTC.
-- Not for a role, not for a permission key: for everyone who signs in.
--
--   permission denied for table deployments_overlap_backup_0183
--
-- logged at 08:28, 08:29, 10:30 and 10:31 UTC on 2026-09-07, each one an
-- attempt by an HR user to separate a guard. 238 separations are recorded; the
-- last is 2026-09-03 13:38 UTC. Zero since the conversion.
--
-- ── THE CAUSE, AND IT IS NOT A PERMISSION ──────────────────────────────────
--
-- `fifteen_employee_rpcs_act_as_the_caller_not_for_them` converted
-- record_separation from SECURITY DEFINER to SECURITY INVOKER. That was the
-- right change and this migration does not undo it. But the body archives any
-- posting it is about to delete:
--
--     insert into public.deployments_overlap_backup_0183
--     select d.*, now(), '...' from public.deployments d where ...;
--
-- and that table is granted to postgres and service_role ONLY. As a definer it
-- ran as the owner and could write it. As an invoker it runs as `authenticated`
-- and cannot.
--
-- TWO THINGS ABOUT THIS ARE WORTH STATING, because both defeated the reading
-- that found it:
--
--   1. A TABLE-LEVEL GRANT IS CHECKED BEFORE ANY ROW IS LOOKED AT. The guard
--      that failed had ONE posting, starting three months BEFORE his last
--      working day, so the select archives ZERO rows — and the statement is
--      refused anyway. "It only runs when there is something to archive" is
--      true of the rows and false of the privilege.
--   2. IT RAISES 42501, the same SQLSTATE an RLS refusal uses, so
--      friendlyDbError rewrote it to "You don't have permission to do this."
--      The user was told they lacked a permission they hold. A message that
--      names the wrong cause sends the investigation to the wrong place, and it
--      sent this one to the permission tables for an afternoon.
--
-- ── THE CLASS, WHICH IS NOT THE ONE CLAUDE.md ALREADY NAMES ────────────────
--
-- CLAUDE.md warns that converting a SET operation to invoker turns an
-- unauthorised act into a quietly smaller result. That is a judgement about
-- intent and is deliberately not automated.
--
-- THIS IS THE OTHER ONE, and it is mechanical: a definer function may write
-- tables that exist only for the owner — backups, copy maps, repair scratch —
-- and conversion makes every one of those a hard refusal on the first call.
-- Nothing about the body looks different. Whether `authenticated` holds INSERT
-- on a table is a fact the database can answer, so unlike the set question this
-- one IS checked, below, and evaluated nightly.
--
-- ── THE FIX: THE BOOKKEEPING RUNS AS THE OWNER, THE USER DATA DOES NOT ─────
--
-- NOT by granting `authenticated` write access to a backup table. It carries
-- RLS with no policies, so a grant alone still refuses, and adding a policy
-- would open an archival table to every user in order to repair a side-write.
--
-- NOT by reverting to SECURITY DEFINER, which would discard the RLS the
-- conversion restored — employees and deployments stay under the caller's own
-- policies, which is the whole point.
--
-- Instead the archival write — and only that — moves into a SECURITY DEFINER
-- helper. It is keyed on the GUARD as well as the row ids, so it cannot be
-- turned into a way to archive somebody else's postings, and it carries the
-- same tenant guard as its callers.

-- ---------------------------------------------------------------------------
-- Step 1. Prove the defect is present before repairing it.
--
-- 9.6: a migration that repairs a condition it never observed cannot tell a fix
-- from a no-op. This block fails the migration if the two functions are NOT
-- currently broken — which is also what stops it being re-applied blindly onto
-- a database somebody already fixed by hand.
-- ---------------------------------------------------------------------------
do $$
declare v_acl boolean; v_def boolean;
begin
  select has_table_privilege('authenticated', 'public.deployments_overlap_backup_0183', 'INSERT')
    into v_acl;
  if v_acl then
    raise exception '0403 REFUSED: authenticated already holds INSERT on deployments_overlap_backup_0183. Somebody granted it — that is a different repair from this one, and the two together would leave an archival table writable by every user. Look at why before continuing.';
  end if;

  select prosecdef into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_separation';
  if v_def is null then raise exception '0403 REFUSED: public.record_separation does not exist.'; end if;
  if v_def then
    raise exception '0403 REFUSED: record_separation is SECURITY DEFINER, so it is not broken in the way this migration repairs. Somebody reverted the conversion; decide which fix stands before applying this one.';
  end if;

  raise notice '0403: confirmed — the backup table is owner-only and record_separation is invoker.';
end $$;

-- ---------------------------------------------------------------------------
-- Step 2. The helper. Definer, tenant-guarded, and narrow.
-- ---------------------------------------------------------------------------
create or replace function public.archive_guard_deployments(
  p_guard uuid, p_deployment_ids uuid[], p_note text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_n int;
begin
  -- tenant guard [resolved]: owning company looked up from p_guard via public.employees (0242)
  if p_guard is not null then perform public.assert_same_company((select company_id from public.employees where id = p_guard)); end if;

  -- BOTH p_guard AND the ids. The ids alone would make this a general-purpose
  -- way to copy any posting into a table the caller cannot read back, which is
  -- a wider thing than the callers need. A definer helper should be able to do
  -- exactly one job.
  insert into public.deployments_overlap_backup_0183
  select d.*, now(), p_note
    from public.deployments d
   where d.guard_id = p_guard
     and d.id = any(coalesce(p_deployment_ids, '{}'::uuid[]));
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

comment on function public.archive_guard_deployments(uuid, uuid[], text) is
  '0403: copies a guard''s named postings into deployments_overlap_backup_0183 before their caller deletes them. SECURITY DEFINER because that table is granted to the owner only — the callers (record_separation, change_guard_shift) are SECURITY INVOKER so that employees and deployments stay under the caller''s RLS, and this is the one write in them that the caller has no grant for. Keyed on the guard AND the row ids so it cannot archive anybody else''s postings.';

revoke execute on function public.archive_guard_deployments(uuid, uuid[], text) from public, anon;
grant  execute on function public.archive_guard_deployments(uuid, uuid[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Step 3. The detector, created BEFORE the repair so it can be seen to fire.
-- ---------------------------------------------------------------------------
create or replace function public.invoker_owner_only_writes()
returns table (function_name text, table_name text)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with tbl as (
    -- Tables the app's own role cannot write. Backups, copy maps, repair
    -- scratch: everything a migration made for itself and never granted.
    select c.oid, c.relname::text nm
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and not has_table_privilege('authenticated', c.oid, 'INSERT')
  ),
  fn as (
    -- INVOKER functions the app's own role can actually CALL. A function
    -- `authenticated` cannot execute cannot fail for a user, so a one-off
    -- migration tool left in the schema is out of scope rather than exempted —
    -- sync_attendance_0188 is the live example, and it also refuses unless
    -- session_replication_role is set, which no app session can do.
    select p.proname::text nm, public.executable_source(pg_get_functiondef(p.oid)) src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and not p.prosecdef and p.prokind = 'f'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  )
  -- executable_source strips comments, so a table merely NAMED in a comment is
  -- not a finding. Matching the write verbs only: reading an owner-only table
  -- is a different question and is governed by SELECT, not INSERT.
  select fn.nm, tbl.nm
    from fn join tbl
      on fn.src ~ ('insert\s+into\s+public\.' || tbl.nm || '\M')
      or fn.src ~ ('update\s+public\.' || tbl.nm || '\M')
      or fn.src ~ ('delete\s+from\s+public\.' || tbl.nm || '\M')
   order by 1, 2;
$fn$;

comment on function public.invoker_owner_only_writes() is
  '0403: SECURITY INVOKER functions that authenticated can call and that write a table authenticated has no INSERT privilege on. Every row is a call that fails with "permission denied for table x" — SQLSTATE 42501, which the frontend reports as a missing permission, so the message names the wrong cause. This is the MECHANICAL half of the invoker-conversion risk; the other half (a set operation becoming a quietly smaller result) is a judgement and is deliberately not automated. See CLAUDE.md.';

revoke execute on function public.invoker_owner_only_writes() from anon, public;
grant  execute on function public.invoker_owner_only_writes() to authenticated, service_role;

-- IT FIRES. Asserted against the live defect, before it is repaired — this is
-- the one moment the condition exists to be observed, and a detector never seen
-- to fire is a detector nobody can trust afterwards.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(function_name || ' -> ' || table_name, ', ' order by function_name)
    into v_n, v_who from public.invoker_owner_only_writes();
  if v_n <> 2 then
    raise exception '0403 REFUSED: the detector reports % finding(s) (%), expected exactly the 2 known ones (change_guard_shift and record_separation, both writing deployments_overlap_backup_0183). A different number means the schema is not what this migration was written against.', v_n, coalesce(v_who, 'none');
  end if;
  raise notice '0403: detector fires on the live defect — %', v_who;
end $$;

-- ---------------------------------------------------------------------------
-- Step 4. Surgery on the two callers. Both have been edited by several
-- migrations, so neither has a canonical file and both are amended against the
-- live definition with an anchor asserted to appear exactly once.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_sep text := '  insert into public.deployments_overlap_backup_0183
  select d.*, now(), ''posting began after last working day - record_separation''
    from public.deployments d
   where d.guard_id = p_guard and d.end_date is null and d.start_date > p_last_working_day;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_separation';

  v_hits := (length(v_def) - length(replace(v_def, a_sep, ''))) / length(a_sep);
  if v_hits <> 1 then
    raise exception '0403 REFUSED: the record_separation archive anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  v_new := replace(v_def, a_sep,
'  -- 0403: the archival copy runs as the OWNER. This function is SECURITY
  -- INVOKER so that employees and deployments stay under the caller''s RLS;
  -- deployments_overlap_backup_0183 is granted to the owner only, and the
  -- inline insert that used to be here failed for every signed-in user — even
  -- when it selected zero rows, because a table grant is checked first.
  perform public.archive_guard_deployments(
    p_guard,
    array(select d.id from public.deployments d
           where d.guard_id = p_guard and d.end_date is null and d.start_date > p_last_working_day),
    ''posting began after last working day - record_separation'');');

  execute v_new;
  raise notice '0403: record_separation archives through the definer helper.';
end $$;

do $$
declare
  v_def text; v_new text; v_hits int;
  a_shift text := '    insert into public.deployments_overlap_backup_0183
    select v_dep.*, now(), ''superseded same-day by change_guard_shift'';';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'change_guard_shift';

  v_hits := (length(v_def) - length(replace(v_def, a_shift, ''))) / length(a_shift);
  if v_hits <> 1 then
    raise exception '0403 REFUSED: the change_guard_shift archive anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  -- SAME DEFECT, NEVER REPORTED. Nobody had changed a guard's shift on the same
  -- day its posting began since the conversion, so this one was waiting rather
  -- than working. Where a defect was found says where to look next.
  v_new := replace(v_def, a_shift,
'    -- 0403: as record_separation — the archival copy runs as the owner.
    perform public.archive_guard_deployments(
      p_guard, array[v_dep.id], ''superseded same-day by change_guard_shift'');');

  execute v_new;
  raise notice '0403: change_guard_shift archives through the definer helper.';
end $$;

-- AND THE DETECTOR IS NOW SILENT. Red before, green after, in one file.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(function_name || ' -> ' || table_name, ', ')
    into v_n, v_who from public.invoker_owner_only_writes();
  if v_n <> 0 then
    raise exception '0403 FAILED: % finding(s) remain after the repair: %', v_n, v_who;
  end if;
  raise notice '0403: detector clear.';
end $$;

-- ---------------------------------------------------------------------------
-- Step 5. Wire the detector into ledger_checks.
--
-- THE CANARY IS READ, INCREMENTED, AND THEN ASKED WHETHER IT PASSES — which is
-- 0402's lesson and the reason it exists. 0400 asserted that ledger_checks
-- returned one more row than before; both counts include the canary, so that
-- assertion moves with the thing it is measuring and cannot see a disagreement.
-- The only assertion that can is the canary's own verdict.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text;
  v_anchor text := 'select ''profit_allocation_exhausts_pool''::text,';
  v_lit    text := 'from (select 36::numeric n) e (n);   -- expected_check_count';
  v_new    text;
  v_hits   int;
  v_co     uuid;
  v_real   int;
  v_passed boolean;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is null then raise exception '0403 REFUSED: no company to verify the canary against.'; end if;

  select count(*) into v_real from public.ledger_checks(v_co) where check_name <> 'checks_evaluated';
  if v_real <> 36 then
    raise exception '0403 REFUSED: ledger_checks evaluates % real checks, not the 36 this migration was written against.', v_real;
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception '0403 REFUSED: the ledger_checks insertion anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  v_hits := (length(v_def) - length(replace(v_def, v_lit, ''))) / length(v_lit);
  if v_hits <> 1 then
    raise exception '0403 REFUSED: the expected_check_count literal "36" appears % time(s), expected 1. If it is 0 the canary has already been bumped past this migration; if it is 2 the number has been duplicated, which is the defect 0302 removed.', v_hits;
  end if;

  v_new := replace(v_def, v_anchor,
    'select ''no_invoker_writes_an_owner_only_table''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.invoker_owner_only_writes()
    union all
    ' || v_anchor);
  v_new := replace(v_new, v_lit,
    'from (select 37::numeric n) e (n);   -- expected_check_count');

  execute v_new;

  select passed into v_passed from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if v_passed is not true then
    raise exception '0403 FAILED: checks_evaluated does not pass after adding the check and bumping the count.';
  end if;
  if not exists (select 1 from public.ledger_checks(v_co)
                  where check_name = 'no_invoker_writes_an_owner_only_table' and passed) then
    raise exception '0403 FAILED: the new check is absent or red immediately after the repair.';
  end if;
  raise notice '0403: ledger_checks wired, 36 -> 37 real checks, canary green.';
end $$;

-- ---------------------------------------------------------------------------
-- Step 6. Probe. Rollback only.
--
-- IT DOES NOT SEPARATE ANYBODY. The archival write is the only thing that was
-- broken and the only thing exercised here; employees and deployments are not
-- touched. Nobody is fired by a migration.
--
-- The probe runs AS A REAL APP USER — a profile holding employees.edit and no
-- admin role — because "does the owner-only write work" is a question about the
-- role the app actually uses, and running it as postgres would answer a
-- different question and pass.
-- ---------------------------------------------------------------------------
do $$
declare
  v_uid  uuid;
  v_co   uuid;
  v_dep  record;
  v_n    int;
  v_err  text;
begin
  select p.id, p.company_id into v_uid, v_co
    from public.profiles p join public.companies c on c.id = p.company_id
   where c.archived_at is null
     and p.role not in ('super_admin', 'super_super_admin')
     and 'employees.edit' = any(coalesce(p.permissions, '{}'))
   order by p.created_at limit 1;
  if v_uid is null then
    raise exception '0403 FAILED: no ordinary profile holds employees.edit, so the identity this defect affects cannot be exercised and the repair would be unverified.';
  end if;

  select d.id, d.guard_id into v_dep
    from public.deployments d join public.employees e on e.id = d.guard_id
   where d.company_id = v_co and e.lifecycle_state = 'active'
   order by d.created_at limit 1;
  if v_dep.id is null then
    raise exception '0403 FAILED: no posting to archive, so the repair cannot be exercised.';
  end if;

  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    perform set_config('role', 'authenticated', true);

    -- (a) THE HALF THAT MUST NOW WORK.
    v_n := public.archive_guard_deployments(v_dep.guard_id, array[v_dep.id], '0403 probe');
    if v_n <> 1 then
      raise exception '0403 FAILED: the helper archived % row(s), expected 1.', v_n;
    end if;

    -- (b) THE HALF THAT MUST STILL REFUSE. The grant was NOT widened: a direct
    --     insert by the same identity, seconds later, is still denied. Without
    --     this the fix could have been "open the table", which is the repair
    --     that was rejected — and two outcomes under identical conditions are
    --     also what proves the first result was not an accident of context.
    begin
      insert into public.deployments_overlap_backup_0183
      select d.*, now(), '0403 probe — direct, must be refused'
        from public.deployments d where d.id = v_dep.id;
      v_err := 'WENT THROUGH';
    exception when others then
      v_err := sqlerrm;
    end;
    if v_err = 'WENT THROUGH' then
      perform set_config('role', 'postgres', true);
      raise exception '0403 FAILED: a direct insert into the backup table succeeded. The table was granted to authenticated, which is the repair this migration refused to make.';
    end if;
    if v_err not like '%permission denied%' then
      perform set_config('role', 'postgres', true);
      raise exception '0403 FAILED: the direct insert was refused, but not by the grant. Got: %', v_err;
    end if;

    perform set_config('role', 'postgres', true);
    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      perform set_config('role', 'postgres', true);
      perform set_config('request.jwt.claims', null, true);
      perform set_config('request.jwt.claim.sub', null, true);
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0403: probe passed — an ordinary user can archive through the helper and still cannot write the table directly.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- archive_guard_deployments(p_guard, ...) is new and is SECURITY DEFINER, which
-- is exactly the shape that needs one: it writes on behalf of a caller whose
-- RLS it does not run under.
--
-- Asserted against the DETECTOR rather than against a reading of the source.
-- Four guard regressions so far — 0348 fixed two, 0352 one, 0363 the fourth —
-- and every one was a guard that was written correctly and never checked
-- against the thing that has to be able to READ it.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0403 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
