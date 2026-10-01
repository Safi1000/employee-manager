-- 0489 — assignments.hr / assignments.accounts reach the writes they name.
--
-- THE DEFECT. PERMISSION_GROUPS grants "Assignments & Pay — edit pay & joining
-- date" (assignments.accounts) and "… fire, rehire, transfer, posting &
-- everything else" (assignments.hr), and the web and mobile Assignments screens
-- render their edit controls on those keys. The database stopped honouring them:
--
--   * employees.perm_write_upd demands employees.edit. A restrictive USING that
--     is false does not raise — the raw updates the screen makes (joining date,
--     branch move, bulk location/branch, the posting columns) touched ZERO rows
--     and the screen reported success. An unauthorised act became a silently
--     smaller result: Taha Arshad (assignments.hr, no employees.edit) has been
--     saving edits that were discarded.
--   * set_employee_salary, change_category, assign_guard_code,
--     assign_display_number, record_separation and change_guard_shift each
--     require_perm('employees.edit') — so every RPC the same screen calls refused.
--   * set_shift_split asked assignments.hr ONLY, while the screens (canHr =
--     assignments.hr || employees.edit) offer it to employees.edit holders too.
--
-- The column-level design already exists and is correct:
-- enforce_assignment_field_perms (BEFORE UPDATE on employees) splits pay/joining
-- date → assignments.accounts and posting/lifecycle → assignments.hr for callers
-- without employees.edit. employee_salary_history already accepts
-- assignments.accounts. The table policy and the RPC gates, added later, simply
-- closed the door in front of it.
--
-- THE FIX.
--   1. employees UPDATE policy: employees.edit OR assignments.hr OR
--      assignments.accounts.
--   2. enforce_assignment_field_perms gains a WHITELIST for callers without
--      employees.edit: only assignment columns (and those other BEFORE triggers
--      derive from them) may move. Without this, (1) would let an
--      assignments-only caller rewrite CNIC, name, bank details … through the
--      API. The existing per-key split still decides WHICH assignment columns.
--   3. The six RPCs accept employees.edit OR the key for their half
--      (salary → accounts; the rest → hr). Each is SECURITY INVOKER, so the
--      table policy from (1) and the trigger from (2) still apply inside them.
--   4. set_shift_split accepts employees.edit as well, matching the screens and
--      the rule the trigger states: "broad editors hold both halves".
--
-- Every function here has been edited by more than one migration, so each is
-- amended by SURGERY against pg_get_functiondef with an anchor asserted to occur
-- exactly once, never restated from a file.

do $mig$
declare
  r record;
  v_def text;
  v_anchor text;
  v_new text;
  v_n int;
begin
  -- (3) + (4): the RPC gates.
  for r in
    select * from (values
      ('set_employee_salary',   $a$perform public.require_perm('employees.edit');$a$, 'assignments.accounts'),
      ('change_category',       $a$perform public.require_perm('employees.edit');$a$, 'assignments.hr'),
      ('assign_guard_code',     $a$perform public.require_perm('employees.edit');$a$, 'assignments.hr'),
      ('assign_display_number', $a$perform public.require_perm('employees.edit');$a$, 'assignments.hr'),
      ('record_separation',     $a$perform public.require_perm('employees.edit');$a$, 'assignments.hr'),
      ('change_guard_shift',    $a$perform public.require_perm('employees.edit');$a$, 'assignments.hr'),
      ('set_shift_split',       $a$perform public.require_perm('assignments.hr');$a$,  'assignments.hr')
    ) as v(fn, anchor, key)
  loop
    select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;
    if v_n <> 1 then
      raise exception 'REFUSED: expected exactly one public.%, found %', r.fn, v_n;
    end if;
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.fn;

    v_new := format(
      $g$if not (public.has_perm('employees.edit') or public.has_perm(%1$L)) then
      raise exception 'permission denied: employees.edit or %2$s required' using errcode = '42501';
    end if;$g$, r.key, r.key);

    -- Replay-safe: already amended → skip.
    if position(v_new in v_def) > 0 then
      continue;
    end if;

    v_n := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_n <> 1 then
      raise exception 'REFUSED: anchor for % found % times (expected 1)', r.fn, v_n;
    end if;
    execute replace(v_def, r.anchor, v_new);
  end loop;

  -- (2): the column whitelist inside enforce_assignment_field_perms.
  select pg_get_functiondef('public.enforce_assignment_field_perms()'::regprocedure) into v_def;
  if position('0489: a caller without employees.edit' in v_def) = 0 then
    v_anchor := E'\n  return new;\nend';
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception 'REFUSED: enforce_assignment_field_perms tail anchor found % times (expected 1)', v_n;
    end if;
    v_new := E'\n' || $b$
  -- 0489: a caller without employees.edit reaches this row only through the
  -- assignments keys (employees.perm_write_upd), so nothing outside the
  -- assignment columns may move. Includes the columns the other BEFORE
  -- triggers derive from them (status, branch_id, assignment_effective_from,
  -- updated_at), which NEW already carries when this "zzz" trigger runs.
  declare v_bad text;
  begin
    select string_agg(n.key, ', ' order by n.key) into v_bad
      from jsonb_each(to_jsonb(new)) n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key
     where n.value is distinct from o.value
       and n.key <> all (array[
         -- assignments.accounts
         'base_salary', 'allowance', 'per_day_salary', 'join_date',
         -- assignments.hr
         'client_id', 'category', 'shift', 'contract_id', 'contract_line_id',
         'branch_id', 'location_id', 'lifecycle_state', 'status',
         'termination_date', 'last_working_day', 'exit_date', 'exit_reason',
         'separation_reason', 'eligible_for_rehire', 'display_number',
         'guard_code', 'employee_code',
         'assignment_effective_from', 'assignment_effective_to',
         -- maintained by trigger
         'updated_at'
       ]);
    if v_bad is not null then
      raise exception 'permission denied: employees.edit is required to change %', v_bad
        using errcode = '42501';
    end if;
  end;
$b$ || E'\n  return new;\nend';
    execute replace(v_def, v_anchor, v_new);
  end if;
end $mig$;

-- (1) The table policy.
drop policy if exists perm_write_upd on public.employees;
create policy perm_write_upd on public.employees as restrictive for update
  using ((select public.has_perm('employees.edit')) or (select public.has_perm('assignments.hr')) or (select public.has_perm('assignments.accounts')))
  with check ((select public.has_perm('employees.edit')) or (select public.has_perm('assignments.hr')) or (select public.has_perm('assignments.accounts')));

-- Both keys must be grantable, or this opens a door nobody can be given.
do $$
begin
  if (select count(*) from public.permission_keys where key in ('assignments.hr', 'assignments.accounts')) <> 2 then
    raise exception 'REFUSED: assignments.hr / assignments.accounts missing from permission_keys';
  end if;
  -- Assert on the thing that can break: each gate now names its key, and the
  -- whitelist is present.
  if exists (
    select 1 from (values
      ('set_employee_salary', 'assignments.accounts'), ('change_category', 'assignments.hr'),
      ('assign_guard_code', 'assignments.hr'), ('assign_display_number', 'assignments.hr'),
      ('record_separation', 'assignments.hr'), ('change_guard_shift', 'assignments.hr'),
      ('set_shift_split', 'assignments.hr')) v(fn, key)
    join pg_proc p on p.proname = v.fn
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    where position(format('or public.has_perm(%L)', v.key) in pg_get_functiondef(p.oid)) = 0
       or position('public.has_perm(''employees.edit'')' in pg_get_functiondef(p.oid)) = 0
  ) then
    raise exception 'REFUSED: an RPC gate was not amended';
  end if;
  if position('0489: a caller without employees.edit' in
       pg_get_functiondef('public.enforce_assignment_field_perms()'::regprocedure)) = 0 then
    raise exception 'REFUSED: column whitelist missing from enforce_assignment_field_perms';
  end if;
end $$;

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
