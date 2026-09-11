-- 0434 — the finance queue is a view a screen reads.
--
-- 0432 added clearance_finance_queue and every_control_is_invoked went from 10
-- findings to 11. The check is right: no function, view, policy or cron job
-- reads that view, and the map of views the APPLICATION reads is the only place
-- a frontend-only reader can be recorded. src/app/pages/super-admin/Clearance.tsx
-- reads it; without this entry the check reports a control nobody invokes, and
-- the next person to add a view learns that the arm is noise.
--
-- kit_holdings needs no entry: return_kit, handover_kit, suggest_kit_fine,
-- deployed_without_kit and enforce_deployment_requires_kit all read it, so the
-- check can see it reached.
--
-- SURGERY. uninvoked_controls has been edited by several migrations, so no file
-- holds its true text and it is amended against the live definition with an
-- anchor asserted to appear exactly once.

do $$
declare
  v_def text; v_new text; v_hits int; v_before int; v_after int;
  a_first text := '      (''compliance_jurisdiction_register'', ''src/app/pages/super-admin/ComplianceCases.tsx''),';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'uninvoked_controls';
  if v_def is null then raise exception '0434 REFUSED: uninvoked_controls does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_first, ''))) / length(a_first);
  if v_hits <> 1 then
    raise exception '0434 REFUSED: the view_exempt anchor appears % time(s), expected 1. Do not widen it.', v_hits;
  end if;

  select count(*) into v_before from public.uninvoked_controls();

  v_new := replace(v_def, a_first,
    '      (''clearance_finance_queue'',          ''src/app/pages/super-admin/Clearance.tsx''),' || chr(10) || a_first);

  execute v_new;

  -- ASSERT ON THE THING THAT CAN BREAK. "One fewer finding" is the only outcome
  -- that distinguishes a correct entry from a typo'd one: a name that matches
  -- nothing leaves the count where it was, and the check stays red while the
  -- migration reports success.
  select count(*) into v_after from public.uninvoked_controls();
  if v_after <> v_before - 1 then
    raise exception
      '0434 FAILED: uninvoked_controls went from % to %, expected one fewer. The exemption name did not match the view.',
      v_before, v_after;
  end if;
  if exists (select 1 from public.uninvoked_controls() where object_name = 'clearance_finance_queue') then
    raise exception '0434 FAILED: clearance_finance_queue is still reported.';
  end if;

  raise notice '0434: uninvoked_controls % -> % findings.', v_before, v_after;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0434 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
