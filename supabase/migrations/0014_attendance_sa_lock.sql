-- ============================================================================
-- ADDITIVE migration. No data loss.
-- Lock attendance rows marked by super_admin / super_super_admin: only those
-- two roles can subsequently update or delete them.
-- - Adds marked_by_user_id + marked_by_role on attendance_records.
-- - BEFORE INSERT OR UPDATE trigger stamps the caller.
-- - RESTRICTIVE RLS policies block non-admins from touching SA-stamped rows.
-- Run this in Supabase Dashboard -> SQL Editor.
-- ============================================================================

alter table public.attendance_records
  add column if not exists marked_by_user_id uuid references auth.users(id) on delete set null;

alter table public.attendance_records
  add column if not exists marked_by_role public.user_role;

create or replace function public.stamp_attendance_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.marked_by_user_id := auth.uid();
  new.marked_by_role := public.current_role();
  return new;
end;
$$;

drop trigger if exists trg_attendance_stamp on public.attendance_records;
create trigger trg_attendance_stamp
  before insert or update on public.attendance_records
  for each row execute function public.stamp_attendance_marker();

-- Restrictive policies are ANDed with permissive ones. They block UPDATE/DELETE
-- of SA-stamped rows unless the caller is also super_admin / super_super_admin.
drop policy if exists "no_modify_sa_locked" on public.attendance_records;
create policy "no_modify_sa_locked" on public.attendance_records
  as restrictive
  for update
  using (
    marked_by_role is null
    or marked_by_role not in ('super_admin', 'super_super_admin')
    or public.current_role() in ('super_admin', 'super_super_admin')
  );

drop policy if exists "no_delete_sa_locked" on public.attendance_records;
create policy "no_delete_sa_locked" on public.attendance_records
  as restrictive
  for delete
  using (
    marked_by_role is null
    or marked_by_role not in ('super_admin', 'super_super_admin')
    or public.current_role() in ('super_admin', 'super_super_admin')

  );
  
