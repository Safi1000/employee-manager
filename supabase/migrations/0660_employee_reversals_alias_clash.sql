-- 0660 — Undo exit, Undo rehire and Undo lifecycle change work again
--
-- Found 11 Nov 2026 while correcting PCI's October: undoing Umar's (GGS-00374)
-- exit failed with `record "e" is not assigned yet`. 0507 gave the three
-- employee reversals a regional guard,
--
--   perform public.assert_branch_writable((select e.branch_id
--     from public.employee_state_snapshots x join public.employees e
--       on e.id = x.employee_id where x.id = p_snapshot_id));
--
-- but each function also declares a PL/pgSQL record variable named `e`. Inside
-- the embedded SQL, PL/pgSQL substitutes its own variable for `e.branch_id`
-- before the table alias can be used, and the record is not yet assigned at
-- that line — so all three functions have refused EVERY call since 0507, on
-- the first line after their permission check. Nothing went red: a refusal
-- looks like a control.
--
-- The change: in reverse_separation, reverse_rehire and
-- reverse_lifecycle_change (which reads employee_lifecycle_events), the
-- subquery's alias becomes `ee`. Surgery against
-- the live definitions (each has more than one author: 0503/0505 and 0507),
-- the anchor asserted to appear exactly once in each.
--
-- Asserted on what can break: a preview of reversing Umar's separation
-- returns its result instead of raising; and no function left in the schema
-- carries the clashing pattern alongside a record named `e`.

do $mig$
declare
  v_fn text; v_def text; v_h1 int; v_h2 int;
  -- reverse_separation / reverse_rehire read employee_state_snapshots;
  -- reverse_lifecycle_change reads employee_lifecycle_events. Both forms share
  -- these two pieces, each of which must appear exactly once per function.
  a1 constant text := '(select e.branch_id from public.employee_';
  b1 constant text := '(select ee.branch_id from public.employee_';
  a2 constant text := 'join public.employees e on e.id = x.employee_id';
  b2 constant text := 'join public.employees ee on ee.id = x.employee_id';
begin
  foreach v_fn in array array['public.reverse_separation(uuid,text,boolean)',
                              'public.reverse_rehire(uuid,text,boolean)',
                              'public.reverse_lifecycle_change(uuid,text,boolean)'] loop
    v_def := pg_get_functiondef(v_fn::regprocedure);
    if position(b2 in v_def) > 0 then continue; end if;   -- already amended
    v_h1 := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
    v_h2 := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
    if v_h1 <> 1 or v_h2 <> 1 then
      raise exception '0660 REFUSED: % anchors appear %/% times, expected 1/1.', v_fn, v_h1, v_h2;
    end if;
    execute replace(replace(v_def, a1, b1), a2, b2);
  end loop;
end $mig$;

do $mig$
declare v_r jsonb; v_left int;
begin
  select count(*) into v_left from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and pg_get_functiondef(p.oid) like '%join public.employees e on e.id = x.employee_id%'
     and pg_get_functiondef(p.oid) ~ '\me\s+record\M';
  if v_left <> 0 then raise exception '0660 REFUSED: % function(s) still carry the clashing alias.', v_left; end if;

  if exists (select 1 from public.employee_state_snapshots where id = '6533e68a-671f-49ce-8feb-560f18632f74') then
    begin
      v_r := public.reverse_separation('6533e68a-671f-49ce-8feb-560f18632f74', '0660 test preview', true);
    exception when others then
      if sqlerrm like '%is not assigned yet%' then
        raise exception '0660 REFUSED: reverse_separation still fails on the alias clash: %', sqlerrm;
      end if;
      -- any other refusal (permission for a session with no user, a business
      -- rule) is not this defect
    end;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0660 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0660 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $mig$;