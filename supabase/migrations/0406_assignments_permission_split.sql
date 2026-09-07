-- 0343 — split Assignments & Pay into two narrower permissions:
--   assignments.accounts → change pay (base_salary / allowance) and joining date;
--                          view fired staff (frontend).
--   assignments.hr       → fire, rehire, transfer, category, shift, posting, and
--                          every other employee-record change on the page.
-- A user may hold one, both, or neither. employees.edit (and super_admin/SSA via
-- has_perm) is a superset of both, so existing broad users are unaffected.
--
-- Enforcement is ONE BEFORE UPDATE trigger on employees. Every action on the page
-- — direct updates, Edit-rules, and the change_category / record_separation /
-- set_employee_salary RPCs — ultimately writes employees columns, so guarding the
-- table catches them all, whatever the path. (auth.uid() is the real caller even
-- inside SECURITY DEFINER RPCs, so has_perm checks the right person.)

-- 1) Catalogue the keys so the grant screen can offer them (mirrors
-- PERMISSION_GROUPS; permission_key_gaps() would otherwise flag them).
insert into public.permission_keys (key, grp, label) values
  ('assignments.accounts', 'Assignments & Pay', 'Edit pay (base salary / allowance) & joining date, view fired'),
  ('assignments.hr',       'Assignments & Pay', 'Fire, rehire, transfer, posting & everything else')
on conflict (key) do nothing;

-- 2) The enforcement trigger.
create or replace function public.enforce_assignment_field_perms()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Nested writes from other triggers (e.g. the 0341 branch cascade / region
  -- inherit) run deeper than the user's own statement — never gate those.
  if pg_trigger_depth() > 1 then return new; end if;
  -- Backend / migration / maintenance sessions carry no end-user JWT.
  if auth.uid() is null or public.is_maintenance_session() then return new; end if;
  -- Broad editors (and super_admin / SSA, via has_perm) hold both halves.
  if public.has_perm('employees.edit') then return new; end if;

  -- Pay + joining date → Accounts. Note: setting a joining date for the FIRST
  -- time (null → date) is part of an HR hire/assignment and is NOT gated here;
  -- only CHANGING an already-recorded joining date is an Accounts edit.
  if new.base_salary is distinct from old.base_salary
     or new.allowance   is distinct from old.allowance
     or (old.join_date is not null and new.join_date is distinct from old.join_date) then
    if not public.has_perm('assignments.accounts') then
      raise exception 'permission denied: assignments.accounts is required to change pay or joining date'
        using errcode = '42501';
    end if;
  end if;

  -- Any other posting / lifecycle change → HR.
  if new.client_id          is distinct from old.client_id
     or new.category         is distinct from old.category
     or new.shift            is distinct from old.shift
     or new.contract_id      is distinct from old.contract_id
     or new.contract_line_id is distinct from old.contract_line_id
     or new.branch_id        is distinct from old.branch_id
     or new.location_id      is distinct from old.location_id
     or new.lifecycle_state  is distinct from old.lifecycle_state
     or new.termination_date is distinct from old.termination_date
     or new.last_working_day is distinct from old.last_working_day
     or new.exit_date        is distinct from old.exit_date
     or new.eligible_for_rehire is distinct from old.eligible_for_rehire
     or new.display_number   is distinct from old.display_number then
    if not public.has_perm('assignments.hr') then
      raise exception 'permission denied: assignments.hr is required for this change'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

-- trg_zzz_ so it runs AFTER the column-setting BEFORE triggers (region inherit,
-- branch-from-client) have produced the final NEW row it judges.
drop trigger if exists trg_zzz_enforce_assignment_field_perms on public.employees;
create trigger trg_zzz_enforce_assignment_field_perms
  before update on public.employees
  for each row execute function public.enforce_assignment_field_perms();

-- This migration adds no authenticated-executable SECURITY DEFINER function with
-- a tenant uuid parameter (the new function is a trigger, argument-less), so it
-- introduces no gap. Assert the detector still reads clean, as every migration must.
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
