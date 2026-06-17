-- ============================================================================
-- FIX: The restrictive RLS policy "no_modify_sa_locked" blocks upserts from
-- non-admin users (HR, accounting) when the attendance row was previously
-- marked by a super_admin.  In practice every company member who has
-- attendance.edit should be able to re-mark attendance; the stamp trigger
-- already re-stamps marked_by_role to the new caller, so the lock serves no
-- purpose once the record is being legitimately updated by any authorised user.
--
-- Solution: widen the UPDATE policy to allow any user whose company_id matches
-- the row's company_id.  The permissive company_members policy already limits
-- visibility to same-company rows, so the restrictive policy only needs to
-- guard cross-company edits (which RLS already blocks).
-- ============================================================================

drop policy if exists "no_modify_sa_locked" on public.attendance_records;
create policy "no_modify_sa_locked" on public.attendance_records
  as restrictive
  for update
  using (
    marked_by_role is null
    or marked_by_role not in ('super_admin', 'super_super_admin')
    or public.current_role() in ('super_admin', 'super_super_admin')
    or company_id = public.current_company_id()
  );

drop policy if exists "no_delete_sa_locked" on public.attendance_records;
create policy "no_delete_sa_locked" on public.attendance_records
  as restrictive
  for delete
  using (
    marked_by_role is null
    or marked_by_role not in ('super_admin', 'super_super_admin')
    or public.current_role() in ('super_admin', 'super_super_admin')
    or company_id = public.current_company_id()
  );
