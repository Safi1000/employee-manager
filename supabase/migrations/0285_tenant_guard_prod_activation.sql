-- 0285 — PRODUCTION ACTIVATION. 0242c and 0248, fused into one transaction.
--
-- FOR THE PRODUCTION DEPLOYMENT ONLY. Dev already carries 0242c and 0248 as
-- separate migrations, applied in that order, and nothing here changes dev.
--
-- ============================================================================
-- WHY THESE TWO CANNOT BE SEPARATE STATEMENTS ON PRODUCTION
-- ============================================================================
--
-- 0242c is the migration that makes the guard fire at all. Until it lands,
-- `assert_same_company` exempts its caller on `current_user`, and SECURITY
-- DEFINER sets `current_user` to the function owner for every caller — so the
-- guard returns without checking anything and 0242's 135 call sites are inert.
--
-- 0248 is the migration that makes those call sites NULL-tolerant. Until it
-- lands, a guard reached with a legitimately absent id raises. `region_for_client
-- (NULL)` is a normal call — an expense need not belong to a client, and twelve
-- functions call it — and on dev this combination broke **every expense insert**.
--
-- Applied in sequence, there is a window between them in which the guard is live
-- and NULL is not tolerated. In that window every legitimate call passing an
-- optional tenant-scoped id as NULL is refused, and the refusal reaches the
-- operator as `Row not found` from a form that has nothing to do with missing
-- rows. That is the same shape as the 0268 cash-receipt regression one layer
-- down: a constraint that correctly refuses what it should, shipped without
-- proving the system still says yes.
--
-- The window cannot be closed by reordering. 0248 must come AFTER 0242c, because
-- 0248's own verification asserts that a FOREIGN client id is still refused with
-- 'Row not found' — which only happens once the guard actually fires. Run first,
-- 0248 aborts on its own self-test.
--
-- So the two go in one transaction. The guard becomes live and NULL-tolerant in
-- the same commit, and the window is not shortened but eliminated.
--
-- ============================================================================
-- WHAT THIS FILE IS, EXACTLY
-- ============================================================================
--
-- The verbatim text of supabase/migrations/0242c_tenant_guard_role_detection.sql
-- followed by the verbatim text of
-- supabase/migrations/0248_tenant_guard_null_tolerant.sql, in that order, with
-- nothing rewritten, reordered, or omitted. The two are concatenated by the
-- build, not retyped: their content is byte-identical to the files that were
-- applied and proved on dev.
--
-- Both migrations' own verification blocks are retained and both run here.
-- 0242c's resets `request.jwt.claims` to NULL before it returns, so 0248's
-- generator runs with no tenant identity, exactly as it does on dev.
--
-- ============================================================================
-- LEDGER CONSEQUENCE, STATED RATHER THAN DISCOVERED
-- ============================================================================
--
-- Production's `supabase_migrations` will record `0285` and will not record
-- `0242c` or `0248`. `scripts/check-migrations.mjs` will therefore report two
-- repo files as unrecorded on prod until their rows are backfilled with their
-- own text — which is accurate, because that text is precisely what ran.
--
-- Backfill both rows after this commits. Do not add either name to
-- `scripts/migration-aliases.txt`: an alias would silence a true statement about
-- the ledger rather than correct it, which is what that file's own header
-- forbids.

-- ############################################################################
-- BEGIN VERBATIM 0242c_tenant_guard_role_detection.sql
-- ############################################################################

-- 0242c — assert_same_company was a no-op. This makes it fire.
--
-- DEV ONLY. 0242 and 0242b must not go to production without this.
--
-- THE BUG
--
-- 0242's helper exempted trusted backend roles like this:
--
--   if current_user not in ('authenticated', 'anon') then return; end if;
--
-- SECURITY DEFINER *sets current_user to the function owner*. That is what the
-- mode does. Every one of the 135 guarded functions is SECURITY DEFINER owned
-- by postgres, so by the time assert_same_company was reached current_user was
-- always 'postgres', the exemption always matched, and the guard returned
-- without checking anything. Measured, not reasoned:
--
--   as authenticated, outside a definer function : current_user = authenticated
--   inside a definer function                    : current_user = postgres
--
-- So 0242 shipped 135 functions that called a guard which never guarded. The
-- reasoning behind the exemption was right — service_role and postgres carry
-- no tenant identity and must be let through, or signup, billing, cron and
-- every migration break. The SIGNAL was wrong.
--
-- HOW IT WAS CAUGHT, WHICH MATTERS MORE THAN THE BUG
--
-- Not by review. 0242's own verification passed: it asserted that every
-- qualifying function CALLS assert_same_company, and every one of them did.
-- That check cannot tell a guard from a no-op with the same name.
--
-- The suite caught it on its first run — 60 of 60 negative cases returned
-- normally where every one should have refused. A test that had only asserted
-- "the guard is present" would have reported 135 passes. This is the whole
-- argument for demonstrating a refusal rather than inspecting for one, and it
-- is why the standing instruction is to prove a guard can fail.
--
-- THE SIGNAL THAT ACTUALLY SURVIVES SECURITY DEFINER
--
-- session_user is no better: PostgREST connects as one authenticator role and
-- switches with SET LOCAL ROLE, so it reads the same for anon, authenticated
-- and service_role alike.
--
-- The JWT claims do survive, because they are a GUC on the session rather than
-- a role attribute, and SECURITY DEFINER does not touch them. They are already
-- what the whole tenancy model rests on — auth.uid() reads the same setting,
-- and current_company_id() reads auth.uid() — so this adds no new dependency.
--
-- TWO INDEPENDENT SIGNALS, AND IT FAILS CLOSED
--
--   1. auth.uid() is not null  -> a real end-user session. ENFORCE.
--   2. the JWT role claim is 'authenticated' or 'anon'. ENFORCE.
--   otherwise (no claims at all: migrations, psql, pg_cron; or role
--   'service_role': Edge Functions, the compliance cron) -> exempt.
--
-- If the claims are present but unparseable the guard ENFORCES rather than
-- exempts. A malformed claim is not a trusted backend, and an exemption that
-- can be reached by corrupting an input is not an exemption.

create or replace function public.assert_same_company(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_jwt_role text;
  v_uid      uuid;
begin
  -- NOTE FOR ANYONE EDITING THIS: do NOT reintroduce current_user or
  -- session_user here. Inside SECURITY DEFINER, current_user is the owner
  -- (postgres) for every caller, and session_user is the authenticator role
  -- for every caller. Both read identically for a logged-in user and for a
  -- migration, which is exactly the bug 0242c exists to fix.
  begin
    v_jwt_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  exception when others then
    v_jwt_role := 'authenticated';   -- unparseable claims fail CLOSED
  end;

  v_uid := auth.uid();

  -- Trusted backend callers carry no tenant identity: service_role (Edge
  -- Functions, the compliance cron) and no-claims contexts (migrations, psql,
  -- pg_cron). current_company_id() returns NULL for all of them, so enforcing
  -- would raise on every signup, billing webhook, cron run and migration.
  if v_uid is null and v_jwt_role not in ('authenticated', 'anon') then
    return;
  end if;

  -- NULL and mismatch raise IDENTICALLY, deliberately: distinguishing them
  -- would turn every guarded function into an existence oracle. The message is
  -- unhelpful ON PURPOSE. Do not split these branches to improve the text.
  if p_company_id is null
     or (p_company_id is distinct from public.current_company_id()
         and not public.is_ssa_unscoped()) then
    raise exception 'Row not found' using errcode = '42501';
  end if;
end
$fn$;

comment on function public.assert_same_company(uuid) is
  'Tenant guard for SECURITY DEFINER functions, which get no caller RLS. Raises 42501 identically for a NULL company and for another company''s, so it cannot be used as an existence oracle. Detects trusted backend callers from auth.uid() and the JWT role claim, NOT from current_user — SECURITY DEFINER rewrites current_user to the owner, which made the 0242 version a no-op. See 0242c.';

-- ---------------------------------------------------------------------------
-- The verification 0242 should have had.
--
-- 0242 asserted that the guard was CALLED. That is satisfied by a guard that
-- does nothing, which is precisely what shipped. This asserts that the guard
-- REFUSES, by binding a real tenant identity and demonstrating both directions
-- against a real function — and it asserts the exemption still works, because
-- a guard that refuses everything would break production just as thoroughly.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_a   uuid;
  v_b   uuid;
  v_p   uuid;
  v_msg text;
  v_ok  boolean;
begin
  -- Exemption first, in this migration's own context: no JWT claims are set
  -- here, so this call MUST pass straight through. If it does not, every
  -- migration from here on would abort.
  perform public.assert_same_company(null);

  select p.company_id, p.id into v_a, v_p
    from public.profiles p
   where p.company_id is not null
     and coalesce(p.role::text, '') <> 'super_super_admin'
   limit 1;
  select c.id into v_b from public.companies c where c.id <> v_a limit 1;

  if v_a is null or v_b is null or v_p is null then
    raise exception '0242c cannot self-test: needs two companies and a non-SSA profile';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_p::text, 'role', 'authenticated')::text, true);

  if public.current_company_id() is distinct from v_a then
    raise exception '0242c self-test ABORTED: current_company_id() is %, expected %',
      public.current_company_id(), v_a;
  end if;

  -- REFUSES another company.
  v_ok := false;
  begin
    perform public.assert_same_company(v_b);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_ok := (v_msg = 'Row not found');
  end;
  if not v_ok then
    raise exception '0242c FAILED: the guard did not refuse company % from a session for %', v_b, v_a;
  end if;

  -- REFUSES a NULL identically — the no-existence-oracle property.
  v_ok := false;
  begin
    perform public.assert_same_company(null);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_ok := (v_msg = 'Row not found');
  end;
  if not v_ok then
    raise exception '0242c FAILED: NULL did not raise the same message as a mismatch — that is an existence oracle';
  end if;

  -- PERMITS the caller's own company. Without this the migration would pass
  -- with a guard that refuses everybody, which is not a fix.
  begin
    perform public.assert_same_company(v_a);
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception '0242c FAILED: the guard refused the caller''s OWN company (%)', v_msg;
  end;

  perform set_config('request.jwt.claims', null, true);
end
$verify$;

-- ############################################################################
-- END 0242c / BEGIN VERBATIM 0248_tenant_guard_null_tolerant.sql
-- ############################################################################

-- 0248 — 0242's guards raise on a legitimately absent id. Fix the call sites.
--
-- DEV ONLY. This is a regression introduced in 0242.
--
-- WHAT BROKE
--
-- Inserting an expense with no client fails:
--
--   INSERT INTO expenses (...)  ->  "Row not found"
--   context: SELECT public.assert_same_company(
--              (select company_id from public.clients where id = p_client_id))
--            in region_for_client
--
-- region_for_client(NULL) is a normal call — an expense need not belong to a
-- client, and twelve functions call it. Before 0242 it returned NULL. After
-- 0242 the lookup yields NULL, assert_same_company raises on NULL, and the
-- insert dies. Every path that passes an optional tenant-scoped id as NULL is
-- affected the same way.
--
-- WHY THE HELPER IS NOT THE PLACE TO FIX IT
--
-- assert_same_company MUST keep raising on NULL. That is the no-existence-
-- oracle property: a non-null id that does not exist resolves to NULL, and it
-- has to be answered identically to an id belonging to another company. If the
-- helper started tolerating NULL, "no such row" would become distinguishable
-- from "not your row" and the whole design would unravel.
--
-- The distinction belongs at the CALL SITE, where the two cases are different
-- things:
--
--   parameter IS NULL     -> the caller made no tenant claim. Nothing to check.
--                            The function's own preconditions govern, exactly
--                            as before 0242.
--   parameter is NOT NULL -> a claim was made. Check it, and answer a missing
--                            row and a foreign row identically.
--
-- This is the shape 0242b already used by hand for post_manual_journal's
-- p_branch_id. It was not generalised — a pattern applied by hand and lost in
-- the generated path, which is its own failure mode. See
-- docs/TENANT_GUARD_REPORT.md.
--
-- WHY THE SUITE DID NOT CATCH IT
--
-- tenant_guard.sql's positive control called each function with the caller's
-- OWN id and never with NULL. Exhaustive in the refusing direction, and testing
-- one of the two shapes a legitimate call takes.

do $gen$
declare
  r       record;
  v_body  text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  p1      int;
  p2      int;
  v_done  int := 0;
begin
  for r in
    select p.oid, p.proname, p.prosrc
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc like '%perform public.assert_same_company(%'
       -- idempotent: skip anything already made NULL-tolerant
       and p.prosrc !~ 'is not null then perform public\.assert_same_company'
     order by p.proname
  loop
    v_body := r.prosrc;

    -- [claimed]:  perform public.assert_same_company(p_company_id);
    v_body := regexp_replace(
      v_body,
      '  perform public\.assert_same_company\((p_\w+)\);',
      '  if \1 is not null then perform public.assert_same_company(\1); end if;',
      'g');

    -- [resolved]: perform public.assert_same_company((select company_id from public.T where id = p_x));
    v_body := regexp_replace(
      v_body,
      '  perform public\.assert_same_company\(\(select company_id from public\.(\w+) where id = (p_\w+)\)\);',
      '  if \2 is not null then perform public.assert_same_company((select company_id from public.\1 where id = \2)); end if;',
      'g');

    if v_body = r.prosrc then
      continue;   -- nothing matched; leave it exactly as it is
    end if;

    v_def  := pg_get_functiondef(r.oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  raise notice '0248 made % guard call site(s) NULL-tolerant', v_done;
end
$gen$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_p uuid; v_client uuid; v_msg text;
      v_n int; v_ok boolean; v_res uuid;
    begin
      -- Every guarded function must STILL call the guard: 0248 must not have
      -- removed protection while making it tolerant.
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n > 0 then
        raise exception '0248 FAILED: % function(s) are no longer correctly guarded', v_n;
      end if;

      select c.id into v_co from public.companies c
       where exists (select 1 from public.clients cl where cl.company_id = c.id) limit 1;
      select p.id into v_p from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      select cl.id into v_client from public.clients cl where cl.company_id <> v_co limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_p::text, 'role','authenticated')::text, true);

      -- 1. NULL is tolerated: this is the call that broke.
      begin
        v_res := public.region_for_client(null);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0248 FAILED: region_for_client(NULL) still raises (%)', v_msg;
      end;

      -- 2. A FOREIGN id is still refused. Without this, 0248 would have
      -- "fixed" the regression by removing the guard.
      if v_client is not null then
        v_ok := false;
        begin
          v_res := public.region_for_client(v_client);
        exception when others then
          get stacked diagnostics v_msg = message_text;
          v_ok := (v_msg = 'Row not found');
        end;
        if not v_ok then
          raise exception '0248 FAILED: a foreign client id is no longer refused';
        end if;
      end if;

      -- 3. A NON-EXISTENT id is still refused, and with the SAME message as a
      -- foreign one. This is the no-existence-oracle property, and it is the
      -- reason the NULL check went at the call site rather than in the helper.
      v_ok := false;
      begin
        v_res := public.region_for_client('00000000-0000-0000-0000-000000000000'::uuid);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg = 'Row not found');
      end;
      if not v_ok then
        raise exception '0248 FAILED: a non-existent client id is not refused identically (%)',
          coalesce(v_msg, '<no error>');
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0248 verification failed: %', v_outcome;
  end if;
end
$verify$;

-- ############################################################################
-- END 0248. Both applied in one transaction; no window between them.
-- ############################################################################
