-- 0341 — a client-assigned employee's region follows their client's region.
--
-- BUG: Assignment & Pay (and every withRegion screen) filters employees by
-- employees.branch_id. But assigning a guard to a client — via change_category,
-- change_client, or the deployment sync — never set branch_id, so a guard whose
-- branch_id was null or stale dropped out of their client's regional view. Client
-- "68 HS" (ISB/RWP) showed 4 of 6 guards under ISB/RWP because two had a null
-- branch_id. Company-wide this stranded ~40 guards (null) and mis-filed 2 (stale).
--
-- RULE (confirmed): an employee assigned to a client takes that client's branch;
-- an employee with NO client keeps whatever branch was set on them directly (that
-- is how office staff get a region), and is never forced to one. So branch is
-- derived from the client ONLY for client-assigned employees.

-- 1) Backfill: point every client-assigned guard's branch at their client's
-- branch. Only rows WITH a client and whose client HAS a branch are touched, so
-- no office-staff / client-less branch is ever cleared.
update public.employees e
   set branch_id = c.branch_id, updated_at = now()
  from public.clients c
 where e.client_id = c.id
   and c.branch_id is not null
   and (e.branch_id is null or e.branch_id <> c.branch_id);

-- 2) Keep it synced on the employee side. When a row carries a client, its branch
-- follows the client's branch (falling back to any existing branch if the client
-- has none, so a region-less client never nulls a guard's branch). No client →
-- untouched (office staff keep their own branch).
create or replace function public.employees_sync_branch_from_client()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.client_id is not null then
    new.branch_id := coalesce(
      (select branch_id from public.clients where id = new.client_id),
      new.branch_id);
  end if;
  return new;
end $$;

drop trigger if exists trg_employees_sync_branch_from_client on public.employees;
-- trg_zzz_… so it runs AFTER the client_id-setting sync triggers (BEFORE triggers
-- fire in name order), reading the client_id they just set.
create trigger trg_zzz_employees_sync_branch_from_client
  before insert or update of client_id, branch_id on public.employees
  for each row execute function public.employees_sync_branch_from_client();

-- 3) Keep it synced on the client side. If a client is moved to another region,
-- carry all its assigned employees along. Guarded on a real (non-null) new branch
-- so clearing a client's region never nulls its guards.
create or replace function public.clients_cascade_branch_to_employees()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.branch_id is not null and new.branch_id is distinct from old.branch_id then
    update public.employees
       set branch_id = new.branch_id, updated_at = now()
     where client_id = new.id
       and branch_id is distinct from new.branch_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_clients_cascade_branch_to_employees on public.clients;
create trigger trg_clients_cascade_branch_to_employees
  after update of branch_id on public.clients
  for each row execute function public.clients_cascade_branch_to_employees();
