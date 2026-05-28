-- Backfill: for every existing non-SSA / non-super_admin user that already
-- has the related "parent" permission, grant the new Sprint 1-5 permissions
-- so nothing they could see yesterday becomes invisible today.
--
-- Mapping rationale:
--   settings.view/edit  →  clients.view/edit, contracts.view/edit
--                          (clients & contracts used to live inside Settings)
--   attendance.*        →  roster.* + incidents.*
--                          (roster + incidents were originally proposed under
--                           the attendance umbrella)
--   reports.view        →  coa.view, period_close.manage
--                          (CoA / Period Close are accounting reports)
--   users.manage        →  audit_log.view  (admins see the audit log)
--
-- super_admin / super_super_admin bypass the array check in hasPermission()
-- so they don't need backfilling.

update public.profiles
   set permissions = (
     select coalesce(array_agg(distinct p), '{}')
     from unnest(
       coalesce(permissions, '{}'::text[]) || array(
         select unnest(case
           when 'settings.view'  = any(coalesce(permissions, '{}')) then array['clients.view', 'contracts.view']
           else array[]::text[]
         end)
       ) || array(
         select unnest(case
           when 'settings.edit'  = any(coalesce(permissions, '{}')) then array['clients.edit', 'contracts.edit']
           else array[]::text[]
         end)
       ) || array(
         select unnest(case
           when 'attendance.view' = any(coalesce(permissions, '{}')) then array['roster.view', 'incidents.view']
           else array[]::text[]
         end)
       ) || array(
         select unnest(case
           when 'attendance.edit' = any(coalesce(permissions, '{}')) then array['roster.edit', 'incidents.edit']
           else array[]::text[]
         end)
       ) || array(
         select unnest(case
           when 'reports.view'    = any(coalesce(permissions, '{}')) then array['coa.view', 'period_close.manage']
           else array[]::text[]
         end)
       ) || array(
         select unnest(case
           when 'users.manage'    = any(coalesce(permissions, '{}')) then array['audit_log.view']
           else array[]::text[]
         end)
       )
     ) as p
   )
 where role not in ('super_admin', 'super_super_admin');
