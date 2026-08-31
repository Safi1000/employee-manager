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
