-- 0241 — An unauthenticated visitor should not be able to call anything.
--
-- SECURITY FIX. Applied to dev and, by named approval, to production.
--
-- WHAT WAS OPEN
--
-- 254 of 279 functions in `public` were executable by `anon`. The anon key
-- ships in the browser bundle, so every one of them was reachable by anyone
-- who had ever loaded the application, with no account.
--
-- 46 of those take an id and never mention company_id, so they have no tenant
-- boundary at all — a SECURITY DEFINER function has no caller RLS, which is
-- the entire point of the mode. Demonstrated from outside with the real
-- shipping anon key against dev, before this migration:
--
--   POST /rest/v1/rpc/effective_salary {"p_employee_id":"<uuid>", ...}
--     -> [{"base_salary":40000.00, "per_day_salary":1290.32, ...}]
--
-- One guard's UUID, no credentials, and a competitor learns that company's
-- pay rates. Ten of the 46 WRITE — disburse_payroll_run flips another
-- company's payroll run to disbursed, verify_employee_identity marks any
-- employee identity-verified.
--
-- THE TRAP THIS MIGRATION AVOIDS
--
-- Revoking from `anon` alone does NOTHING. The ACL on every function reads:
--
--   =X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/...
--
-- The leading `=X/postgres` is a grant to **PUBLIC**, and `anon` inherits it.
-- Revoke the explicit anon grant and the PUBLIC grant still lets anon call
-- everything — a change that reads as a fix in the migration log and closes
-- nothing. Both are revoked below, and the verification asserts on the
-- effective privilege via has_function_privilege() rather than on the ACL
-- text, so it cannot pass while being wrong.
--
-- WHY THE GRANT-BACK LIST IS EMPTY
--
-- Read out of the frontend rather than reasoned about, because a wrong answer
-- here breaks production for real users:
--
--   * Every file containing `.rpc(` is behind RequireAuth, with one exception:
--     auth.tsx calls enforce_subscription_expiry — inside
--     `if (data.session?.user)`, so a session already exists and the JWT role
--     is `authenticated`, not `anon`.
--   * Signup and checkout (/signup, /signup/complete) call
--     supabase.functions.invoke(...) — Edge Functions on /functions/v1/, which
--     do not go through PostgREST and are unaffected by EXECUTE grants.
--     billing-checkout, signup-complete and stripe-webhook use SERVICE_ROLE
--     internally.
--   * The compliance cron does NOT run on anon and needs no change:
--     send-compliance-alerts builds its client with SUPABASE_SERVICE_ROLE_KEY,
--     and invoke_send_compliance_alerts() reads the service key from vault.
--   * The landing page makes no Supabase calls at all.
--
-- So: default deny, no exceptions. If a public-facing RPC is ever added, it
-- gets an explicit GRANT in its own migration with the reason written down.
--
-- `authenticated` and `service_role` are untouched. Logged-in users send the
-- anon key as the `apikey` gateway header but their JWT resolves the role to
-- `authenticated`, which keeps its own explicit grant.

-- Snapshot what `authenticated` can call BEFORE touching anything. The
-- assertion at the foot is a DIFFERENTIAL: authenticated must lose nothing.
--
-- The first version of this migration asserted that authenticated could
-- execute EVERY function in public, and it failed — correctly, and on a wrong
-- assumption of mine rather than on a bad revoke. Four functions have no
-- explicit authenticated grant and were relying on PUBLIC:
--
--   applied_migration_digests()      migration checker, service_role only
--   applied_migration_names()        migration checker, service_role only
--   sync_attendance_0188()           one-off admin RPC, superuser-gated
--   enforce_contract_line_headcount() trigger function whose EXECUTE was
--                                    deliberately revoked -- there is a
--                                    migration named
--                                    enforce_contract_line_headcount_revoke_execute
--
-- None of those should be granted to authenticated. Restoring them would have
-- undone a deliberate restriction in the name of a security fix.
--
-- That last one is also the evidence that revoking EXECUTE on a trigger
-- function does not break the trigger: it has been revoked and firing for
-- migrations, and PostgreSQL checks function privilege at CREATE TRIGGER time,
-- not on each fire.
create temp table _auth_before_0241 on commit drop as
  select p.oid
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');

revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from public;

-- Future functions. Without this the next migration silently re-opens
-- everything it creates, because Postgres grants EXECUTE to PUBLIC by default
-- and Supabase's default privileges add anon on top.
--
-- This binds to objects created by `postgres`, which is what runs migrations.
-- Supabase's own `supabase_admin` default ACL is left alone -- it is not ours
-- to change, and anything supabase_admin creates in `public` would regain the
-- grant. Recorded here rather than silently accepted.
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

do $verify$
declare
  v_open  int;
  v_names text;
  v_lost  text;
begin
  select count(*) into v_open
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_open > 0 then
    select string_agg(p.proname, ', ' order by p.proname) into v_names
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and has_function_privilege('anon', p.oid, 'EXECUTE');
    raise exception '0241 left % function(s) callable by anon: %', v_open, left(v_names, 400)
      using errcode = '42501';
  end if;

  -- The other direction, which matters just as much: every logged-in user goes
  -- through `authenticated`, so it must be able to call exactly what it could
  -- call a moment ago -- no more, and critically no less.
  select string_agg(p.proname, ', ' order by p.proname) into v_lost
    from _auth_before_0241 b
    join pg_proc p on p.oid = b.oid
   where not has_function_privilege('authenticated', p.oid, 'EXECUTE');

  if v_lost is not null then
    raise exception '0241 took EXECUTE away from authenticated on: % -- logged-in users would break', left(v_lost, 400)
      using errcode = '42501';
  end if;
end
$verify$;
