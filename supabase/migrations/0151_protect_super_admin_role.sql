-- 0151: Protect Super Admin accounts — only a Super Super Admin may create
-- (promote), demote, or delete a Super Admin. Mirrors the existing rule that
-- only an SSA can reset a Super Admin's password. UI enforces this too
-- (UserManagement edit/delete), but this trigger is the real boundary.
--
-- Rules (acting user = auth.uid()'s role):
--   * Deleting a profile whose role is 'super_admin'      → SSA only.
--   * Changing an existing 'super_admin' to another role  → SSA only (demotion).
--   * Changing any role UP to 'super_admin' (promotion)   → SSA only.
-- A NULL acting role (service_role / no auth context, e.g. edge-function seeds)
-- is trusted and allowed, so back-office automation is unaffected.

create or replace function public.guard_super_admin_mutations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acting public.user_role := public.current_role();
begin
  -- Trusted contexts (service role / no session) and the SSA pass unconditionally.
  if v_acting is null or public.is_super_super_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.role = 'super_admin' then
      raise exception 'Only a Super Super Admin can delete a Super Admin';
    end if;
    return old;
  end if;

  -- UPDATE: block demoting an existing Super Admin or promoting anyone into one.
  if old.role = 'super_admin' and new.role is distinct from old.role then
    raise exception 'Only a Super Super Admin can change a Super Admin''s role';
  end if;
  if new.role = 'super_admin' and old.role is distinct from 'super_admin' then
    raise exception 'Only a Super Super Admin can grant the Super Admin role';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_super_admin_mutations on public.profiles;
create trigger trg_guard_super_admin_mutations
  before update or delete on public.profiles
  for each row execute function public.guard_super_admin_mutations();
