-- 0305 — the detector did not recognise 0303's guard. Teach it, do not exempt it.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHAT HAPPENED
--
-- 0303 gave three SECURITY DEFINER functions a p_company_id parameter and
-- guarded each one through public.resolve_company_scope(p_company_id), which
-- calls assert_same_company on any non-null argument.
--
-- tenant_guard_covers_every_parameter went red on all four companies, naming
-- exactly those three. tenant_guard_covered() matches the literal text
-- `assert_same_company(... p_company_id ...)` in the function body, and 0303's
-- bodies say `resolve_company_scope(p_company_id)` instead.
--
-- So the check was doing its job. It said "this parameter is not guarded by
-- any means I can see", which was true of what it could see.
--
-- TWO WAYS TO CLEAR IT, AND ONLY ONE OF THEM IS HONEST
--
-- The exempt list in tenant_guard_gaps() would take three more rows and the
-- red would be gone in a minute. That is the move CLAUDE.md warns about for
-- migration-aliases.txt, in a different file: silencing a failure by naming it
-- rather than by fixing it. The exempt list is for parameters that genuinely
-- cannot be guarded — polymorphic ids, the branch validator itself.
--
-- These three ARE guarded. The detector is what is incomplete, so the detector
-- is what changes: one named indirection, resolve_company_scope, recognised
-- alongside the two assert functions.
--
-- AND THE NEW TRUST IS VERIFIED, NOT ASSUMED
--
-- Trusting a helper is only sound while the helper does what it claims. The
-- verification below asks the ORIGINAL, unchanged predicate whether
-- resolve_company_scope's own body guards its own parameter — so the detector
-- validates its delegate with the same test it applies to everything else. If
-- someone later edits resolve_company_scope to stop calling
-- assert_same_company, that assertion is what notices.
--
-- The whitelist is deliberately one name long. Every entry is a place where
-- the check now believes something it cannot see, and that list should be
-- short enough to read.

create or replace function public.tenant_guard_covered(p_src text, p_param text)
returns boolean
language sql
immutable
as $$
  select public.executable_source(p_src) ~ ('assert_same_company\([^;]*\m' || p_param || '\M')
      or public.executable_source(p_src) ~ ('assert_branch_in_company\([^;]*\m' || p_param || '\M')
      -- 0305. resolve_company_scope(x) calls assert_same_company(x) for every
      -- non-null x and returns the session tenant otherwise. It is a guard,
      -- spelled differently. The verification in 0305 proves it still is.
      or public.executable_source(p_src) ~ ('resolve_company_scope\([^;]*\m' || p_param || '\M');
$$;

comment on function public.tenant_guard_covered(text, text) is
  'Does this function body guard this uuid parameter? Recognises assert_same_company, assert_branch_in_company, and resolve_company_scope (0305) — the last being an indirection that calls the first. Keep this list short: each entry is something the detector believes without seeing.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_gaps int;
      v_bad  int;
      v_src  text;
    begin
      -- 1. THE DELEGATE IS ITSELF GUARDED, ASKED WITH THE ORIGINAL PREDICATE.
      -- Not "does resolve_company_scope exist" but "does its body do the thing
      -- the detector now takes on trust".
      select p.prosrc into v_src from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = 'resolve_company_scope';
      if v_src is null then
        raise exception '0305 FAILED: resolve_company_scope does not exist, so the whitelist entry is a lie';
      end if;
      if public.executable_source(v_src) !~ 'assert_same_company\([^;]*\mp_company_id\M' then
        raise exception '0305 FAILED: resolve_company_scope no longer guards its own parameter — the whitelist entry must be removed, not kept';
      end if;

      -- 2. THE THREE FUNCTIONS 0303 TOUCHED ARE NO LONGER REPORTED.
      select count(*) into v_bad from public.tenant_guard_gaps() g
       where g.function_name in ('partner_basis_for_report', 'client_statement_loaded',
                                 'partnership_allocation');
      if v_bad <> 0 then
        raise exception '0305 FAILED: % of 0303''s functions are still reported as unguarded', v_bad;
      end if;

      -- 3. AND THE CHECK IS GREEN AGAIN, ON EVERY COMPANY.
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'tenant_guard_covers_every_parameter' and not l.passed;
      if v_bad <> 0 then
        raise exception '0305 FAILED: tenant_guard_covers_every_parameter is still red on % compan(ies)', v_bad;
      end if;

      -- 4. NON-VACUITY, BOTH DIRECTIONS. A predicate loosened until it accepts
      -- everything would satisfy 1-3 and be worthless. Two probe functions of
      -- the exact shape the detector examines — SECURITY DEFINER, executable
      -- by authenticated, one uuid parameter — one guarded and one not.
      create function public.zz_0305_probe_unguarded(p_company_id uuid)
        returns int language sql security definer as 'select 1';
      create function public.zz_0305_probe_guarded(p_company_id uuid)
        returns int language sql security definer as
        'select 1 where public.resolve_company_scope(p_company_id) is not null';
      grant execute on function public.zz_0305_probe_unguarded(uuid) to authenticated;
      grant execute on function public.zz_0305_probe_guarded(uuid) to authenticated;

      select count(*) into v_gaps from public.tenant_guard_gaps() g
       where g.function_name = 'zz_0305_probe_unguarded';
      if v_gaps <> 1 then
        raise exception '0305 FAILED: the detector did not report an unguarded parameter — it now accepts everything';
      end if;

      select count(*) into v_gaps from public.tenant_guard_gaps() g
       where g.function_name = 'zz_0305_probe_guarded';
      if v_gaps <> 0 then
        raise exception '0305 FAILED: the detector still reports a parameter guarded through resolve_company_scope';
      end if;

      -- Dropped BEFORE the verdict, not after: a failure below must not leave
      -- probe functions behind for the next reader (the 0289/0290 lesson).
      drop function public.zz_0305_probe_unguarded(uuid);
      drop function public.zz_0305_probe_guarded(uuid);

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0305 verification failed: %', v_outcome;
  end if;
end
$verify$;
