-- Keep an employee's branch in sync with their client's branch.
--
-- Background: employees.branch_id is stored independently of the client's
-- branch. When a client's branch was changed after its employees were
-- assigned (or employees were bulk-imported with a default branch), the two
-- drifted apart, leaving employees invisible to branch-scoped users for the
-- branch their client actually belongs to.
--
-- This trigger enforces the invariant "an employee's primary branch follows
-- their client's branch" for every write path (Clients page, Settings, bulk
-- import, direct SQL). It only cascades when the client gets a concrete
-- branch (never nulls employees if a client's branch is cleared).
create or replace function public.cascade_client_branch_to_employees()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.branch_id is not null and new.branch_id is distinct from old.branch_id then
    -- Move the client's employees onto the client's (new) branch.
    update public.employees
      set branch_id = new.branch_id, updated_at = now()
      where client_id = new.id
        and branch_id is distinct from new.branch_id;

    -- Drop now-redundant secondary-branch rows that equal the new primary.
    delete from public.employee_branches eb
      using public.employees e
      where eb.employee_id = e.id
        and e.client_id = new.id
        and eb.branch_id = new.branch_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cascade_client_branch on public.clients;
create trigger trg_cascade_client_branch
  after update of branch_id on public.clients
  for each row
  execute function public.cascade_client_branch_to_employees();
