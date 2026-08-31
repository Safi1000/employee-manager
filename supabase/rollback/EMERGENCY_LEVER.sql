-- EMERGENCY LEVER — tenant guard, production.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This is NOT a rollback. Running it restores the cross-tenant RPC leak that
-- the tenant-guard deployment exists to close: 135 SECURITY DEFINER functions
-- become callable by any authenticated user of any company against any other
-- company's ids, exactly as they were before the deployment.
--
-- It exists for one situation: the deployed guard is refusing LEGITIMATE
-- traffic and the product is broken for paying operators. In that situation a
-- known leak for an hour beats an unusable system, and the alternative --
-- restoring 135 rewritten function bodies under pressure -- is slower and far
-- more likely to go wrong.
--
-- It works because every one of the 135 rewritten bodies calls this one
-- function. Disabling it disables all of them in a single statement, without
-- touching a single rewritten body. Nothing is lost and nothing needs undoing
-- except running PART 2 below.
--
-- If instead a SPECIFIC function's body is wrong, do not use this. Extract that
-- function's block from prod_secdef_functions_20260901.sql and restore it
-- alone.

-- ===========================================================================
-- PART 1 — PULL THE LEVER. Guards off.
-- ===========================================================================

create or replace function public.assert_same_company(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- EMERGENCY LEVER PULLED. The tenant guard is disabled and every caller is
  -- permitted. This is the pre-0242 exposure, deliberately reinstated. Restore
  -- with PART 2 of supabase/rollback/EMERGENCY_LEVER.sql as soon as the cause
  -- of the refusal is understood.
  return;
end
$fn$;

-- ===========================================================================
-- PART 2 — PUT IT BACK. Verbatim 0242c. Guards on.
-- ===========================================================================

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

-- ===========================================================================
-- CONFIRM WHICH STATE YOU ARE IN
-- ===========================================================================
--   select prosrc ilike '%EMERGENCY LEVER PULLED%' as lever_pulled
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname = 'assert_same_company';
