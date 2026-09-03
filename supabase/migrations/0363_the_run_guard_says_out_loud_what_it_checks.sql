-- 0363 — post_profit_allocation's tenant guard, spelled so the detector can
--        read it.
--
-- MY OWN REGRESSION, AND THE THIRD OF ITS KIND IN THIS PROJECT. 0348 fixed two
-- I introduced in 0345 and 0347; 0352 fixed one I introduced in 0349. This is
-- the same mistake a fourth time and it is worth naming rather than quietly
-- patching: I keep writing a guard that is correct and then not checking that
-- tenant_guard_gaps() agrees.
--
-- WHAT WAS ACTUALLY WRONG, WHICH IS NOT NOTHING. 0361 wrote:
--
--     select * into v_run from public.profit_allocation_runs where id = p_run_id;
--     perform public.assert_same_company(v_run.company_id);
--
-- That IS a guard, and it does refuse a cross-tenant run. But
-- tenant_guard_covered() matches on the PARAMETER NAME appearing inside the
-- guard call, and `p_run_id` does not appear inside it — so the detector
-- reported a gap it could not see through.
--
-- The tempting fix is an exemption entry, next to the ones for
-- record_invoice_payment and assign_employee_code, saying "already checked".
-- REFUSED, for the reason CLAUDE.md gives about migration-aliases.txt: adding
-- an entry to silence a failure defeats the file's purpose. Those exemptions
-- exist for cases that CANNOT be spelled visibly — a polymorphic p_ref_id whose
-- table is a text argument. This one can.
--
-- So the guard is rewritten to resolve the company inside the call, which makes
-- it visible to the detector AND puts it FIRST, ahead of every read. Guarding
-- before reading is the better order anyway: the old shape read the row and
-- then asked whether it was allowed to.
--
-- A missing run resolves to NULL, assert_same_company returns early on NULL,
-- and the 'not found' raise below still fires — so a bad id is still a clear
-- "not found" rather than a confusing permission error.

do $$
declare
  v_def  text;
  v_hits int;
  a_old  text :=
    '  select * into v_run from public.profit_allocation_runs where id = p_run_id;'
    || chr(10) ||
    '  if not found then raise exception ''Partnership run not found.''; end if;'
    || chr(10) || chr(10) ||
    '  -- tenant guard [resolved, 0287]: the company comes off the run, not the caller'
    || chr(10) ||
    '  perform public.assert_same_company(v_run.company_id);';
  a_new  text :=
    '  -- tenant guard [resolved, 0287], and it goes FIRST. Resolving the company'
    || chr(10) ||
    '  -- inside the call is not decoration: tenant_guard_covered() matches on the'
    || chr(10) ||
    '  -- parameter name appearing within the guard, so a guard that reads the row'
    || chr(10) ||
    '  -- first and guards second is invisible to the thing that checks guards.'
    || chr(10) ||
    '  perform public.assert_same_company('
    || chr(10) ||
    '    (select r.company_id from public.profit_allocation_runs r where r.id = p_run_id));'
    || chr(10) || chr(10) ||
    '  select * into v_run from public.profit_allocation_runs where id = p_run_id;'
    || chr(10) ||
    '  if not found then raise exception ''Partnership run not found.''; end if;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_profit_allocation';
  if v_def is null then raise exception '0363 REFUSED: post_profit_allocation does not exist.'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_old, ''))) / length(a_old);
  if v_hits <> 1 then
    raise exception
      '0363 REFUSED: the load-then-guard block appears % time(s) in post_profit_allocation, expected exactly 1.', v_hits;
  end if;

  execute replace(v_def, a_old, a_new);
  raise notice '0363: post_profit_allocation guards before it reads, visibly.';
end $$;

-- ---------------------------------------------------------------------------
-- The detector must now agree. Asserting on tenant_guard_gaps() rather than on
-- my reading of the source is the whole point of the migration.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0363 FAILED: tenant_guard_gaps() still reports % gap(s): %', v_n, v_who;
  end if;
  raise notice '0363: tenant_guard_gaps() is empty.';
end $$;
