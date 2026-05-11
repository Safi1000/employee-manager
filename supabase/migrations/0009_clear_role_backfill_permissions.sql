-- ============================================================================
-- Clear role-based permission backfill from 0008.
-- Going forward, permissions are strictly per-user: a creator/editor explicitly
-- picks which features each user can access. Role no longer implies any access.
-- super_super_admin and super_admin still have implicit full access (frontend).
-- This migration is ADDITIVE / non-destructive — it only resets the permissions
-- array; no rows are deleted, no columns are dropped.
-- ============================================================================

update public.profiles
set permissions = '{}'
where role in ('hr', 'accounting');
