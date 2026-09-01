-- 0243 — The check that makes 0242 hold for the next function somebody writes.
--
-- DEV ONLY, same as 0242.
--
-- WHY THIS EXISTS
--
-- 0242 closed 133 functions. It does nothing about the 134th. Somebody adds a
-- SECURITY DEFINER function next month, grants it to authenticated, gives it a
-- p_employee_id, and the hole is back with nothing to notice.
--
-- HOW IT DECIDES, AND WHY IT DOES NOT USE HEURISTICS
--
-- The first pass at this audit classified functions by NAME, VOLATILITY and
-- RETURN TYPE. In one pass it got four wrong:
--
--   reassign_client_employee_codes  VOLATILE, returns a count  -> called it a read.
--                                   It loops and rewrites every guard's
--                                   employee_code for a whole client.
--   check_deploy_guard              named "check", returns text[] -> called it a read.
--                                   It calls raise_alert, which INSERTs.
--   check_disbursement              named "check", returns text -> called it a read.
--                                   Also raise_alert.
--   assert_cheque_capacity          VOLATILE, named "assert" -> called it a write.
--                                   It only selects. (Wrong in the other
--                                   direction, and worth stating.)
--
-- So this check infers nothing. It tests the property directly: does the
-- function CALL assert_same_company. A function either does or it does not,
-- and no naming convention can fake it.
--
-- IT CATCHES BOTH SHAPES
--
-- The two patterns fail differently and a check that knew only one would pass
-- the other straight through:
--
--   [resolved] shape — takes an object id and has no resolved-company assert.
--   [claimed]  shape — takes p_company_id and has no direct assert.
--
-- And one failure that is not an omission at all but is worse, because it
-- looks correct in review: resolving a parameter against the table the
-- parameter itself names, which compares a value to itself and proves nothing.

create or replace function public.tenant_guard_gaps()
returns table(function_name text, args text, shape text, reason text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with candidates as (
    select p.oid, p.proname::text as fname,
           pg_get_function_identity_arguments(p.oid) as fargs,
           p.prosrc,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as grantable
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef
       and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
       -- The guard itself, and the small exempt set, each carry a recorded
       -- verdict in their COMMENT. Reading the exemption off the comment
       -- rather than a hard-coded list means a future exemption must state
       -- its reason in the database to be honoured at all.
       and p.proname <> 'assert_same_company'
       and coalesce(obj_description(p.oid, 'pg_proc'), '') not like 'TENANT GUARD EXEMPT%'
  )
  select c.fname, c.fargs,
         case when c.fargs ilike 'p_company%' then 'claimed' else 'resolved' end,
         case
           when not c.prosrc ilike '%assert_same_company%'
             then 'takes a tenant-scoped uuid and never calls assert_same_company'
           when c.fargs ilike 'p_company%'
            and c.prosrc !~ 'assert_same_company\s*\(\s*p_company'
             then 'takes p_company_id but does not assert on the parameter directly'
           when c.fargs not ilike 'p_company%'
            and c.prosrc !~ 'assert_same_company\s*\(\s*\(\s*select'
             then 'takes an object id but does not assert on a resolved company'
           when c.prosrc ~ 'assert_same_company\(\(select company_id from public\.companies where id = p_company_id\)\)'
             then 'resolves p_company_id against companies.id — compares the parameter to itself'
           else null
         end
    from candidates c
   where c.grantable
     and (not c.prosrc ilike '%assert_same_company%'
          or (c.fargs ilike 'p_company%' and c.prosrc !~ 'assert_same_company\s*\(\s*p_company')
          or (c.fargs not ilike 'p_company%' and c.prosrc !~ 'assert_same_company\s*\(\s*\(\s*select')
          or c.prosrc ~ 'assert_same_company\(\(select company_id from public\.companies where id = p_company_id\)\)')
   order by 1;
$function$;

comment on function public.tenant_guard_gaps() is
  'Returns every SECURITY DEFINER function reachable by authenticated that takes a tenant-scoped uuid and is not correctly guarded by assert_same_company. Tests the property directly — does it call the guard — because name, volatility and return type each misclassified functions during the 0242 audit. Zero rows is the only acceptable result. Exemptions are read from each function''s COMMENT, so an exemption must state its reason in the database to count.';

revoke execute on function public.tenant_guard_gaps() from anon, public;
grant  execute on function public.tenant_guard_gaps() to authenticated, service_role;

-- The check must be green the moment it is created, and it must be able to go
-- red. The second half is what the suite in supabase/tests/tenant_guard.sql
-- proves by removing a guard and confirming this function reports it.
do $verify$
declare
  v_n   int;
  v_bad text;
begin
  select count(*), string_agg(function_name || ' [' || shape || '] ' || reason, '; ')
    into v_n, v_bad
    from public.tenant_guard_gaps();

  if v_n > 0 then
    raise exception '0243: % unguarded SECURITY DEFINER function(s) remain: %', v_n, left(v_bad, 600)
      using errcode = '42501';
  end if;

  -- Non-vacuity. A gap check that returns zero rows because it examines zero
  -- functions is indistinguishable from one that returns zero rows because
  -- everything is guarded. Prove it is actually looking at the population.
  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and p.prosrc ilike '%assert_same_company%';
  if v_n < 120 then
    raise exception '0243: only % guarded functions found — 0242 did not land, so this check is green over nothing', v_n;
  end if;
end
$verify$;
