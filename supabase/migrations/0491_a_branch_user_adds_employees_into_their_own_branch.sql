-- 0491 — a branch-bound user adds employees into their own branch.
--
-- Found: Shafqat Ali (partner, RMD, branch = Lahore) holds employees.edit and
-- was still refused on Add Employee — "new row violates row-level security
-- policy branch_scope for table employees", twice on 2026-10-01.
--
-- The Add Employee form (web and mobile) has no branch picker, so it inserts
-- branch_id = null. branch_scope lets a branched user write only rows in their
-- own branch, and null is not their branch. Users with no branch were never
-- affected, which is why it surfaced only now. Office staff fared no better:
-- trg_default_office_staff_branch fills Head Office, which is also not theirs.
--
-- Fix: on INSERT with no branch given, a branched user's own branch is filled.
-- Named trg_a_* so it fires BEFORE trg_default_office_staff_branch (triggers
-- fire alphabetically); trg_zzz_employees_sync_branch_from_client still runs
-- last, so a client's branch still wins wherever a client is set. An explicit
-- branch_id is never touched — branch_scope stays the check on it.

create or replace function public.default_branch_to_branched_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.branch_id is null and public.is_branched_user() then
    new.branch_id := public.current_branch_id();
  end if;
  return new;
end $function$;

comment on function public.default_branch_to_branched_user() is
  '0491: an employee inserted with no branch by a branch-bound user lands in that user''s branch. Without it the Add Employee form (no branch picker) inserts null and branch_scope refuses every add by a branched user.';

drop trigger if exists trg_a_default_branch_to_branched_user on public.employees;
create trigger trg_a_default_branch_to_branched_user
  before insert on public.employees
  for each row
  execute function public.default_branch_to_branched_user();

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0491 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
