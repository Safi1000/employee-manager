-- ============================================================================
-- BACKFILL: any profile currently pinned to its company's Head Office branch
-- becomes unscoped (branch_id = null), aka "No branch — unrestricted
-- (Head Office admin)". The Head Office branch row is preserved because other
-- modules (expenses, accounting) still route office costs through it.
-- ============================================================================

update public.profiles p
   set branch_id = null
  from public.branches b
 where b.id = p.branch_id
   and b.is_head_office = true;
