-- 0455 — Stage B part 3 (final): apply_money_delta becomes internal-only.
--
-- Every function that calls apply_money_delta is now SECURITY DEFINER (0453/0454),
-- each asserting its own permission and tenant before moving money. apply_money_
-- delta itself carries no business key — it is the shared leaf mover. Revoke its
-- direct EXECUTE from the client roles so the ONLY way to reach it is through a
-- sanctioned parent that has already checked who may move money and for whom. The
-- definer parents run as the function owner and keep access; no frontend has ever
-- called apply_money_delta directly.
--
-- Side effect, intended: with authenticated unable to execute it, apply_money_delta
-- drops out of tenant_guard_gaps()'s scan set (that detector only inspects
-- functions authenticated can call), so it is no longer an attack surface to guard.

revoke execute on function public.apply_money_delta(uuid, text, uuid, numeric, text, text, text)
  from public, authenticated, anon;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_auth boolean; v_bad text;
begin
  select has_function_privilege('authenticated',
           'public.apply_money_delta(uuid, text, uuid, numeric, text, text, text)'::regprocedure, 'EXECUTE')
    into v_auth;
  if v_auth then
    raise exception '0455 FAILED: authenticated can still EXECUTE apply_money_delta.';
  end if;

  -- Every caller must still be DEFINER, or it can no longer reach the leaf.
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname <> 'apply_money_delta'
    and pg_get_functiondef(p.oid) ~* '\mapply_money_delta\s*\('
    and not p.prosecdef;
  if v_bad is not null then
    raise exception '0455 FAILED: these call apply_money_delta but are not DEFINER: %', v_bad;
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0455 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
