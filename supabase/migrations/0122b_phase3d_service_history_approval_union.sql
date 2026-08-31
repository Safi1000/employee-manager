-- 0122b — employee_service_history gains the approval-events union
--
-- RECOVERED from supabase_migrations.schema_migrations on 2026-08-31.
-- This migration was applied directly to the database (SQL editor / MCP) and
-- never written back to the repo. Committed verbatim so the repo records what
-- actually ran. See docs/MIGRATION_DIVERGENCE.md.

create or replace view public.employee_service_history
  with (security_invoker = true) as
  select ele.employee_id, ele.company_id, 'lifecycle'::text as kind,
         ele.changed_at as event_at,
         (ele.from_state || ' → ' || ele.to_state)::text as title,
         ele.reason as detail
    from public.employee_lifecycle_events ele
  union all
  select dw.employee_id, dw.company_id, 'warning',
         dw.issued_on::timestamptz,
         ('Warning ' || dw.warning_number || case when dw.rescinded then ' (rescinded)' else '' end),
         dw.reason
    from public.disciplinary_warnings dw
  union all
  select ig.employee_id, inc.company_id, 'incident',
         inc.occurred_at,
         ('Incident: ' || coalesce(inc.category::text, 'event')),
         inc.description
    from public.incident_guards ig
    join public.incidents inc on inc.id = ig.incident_id
  union all
  select tr.employee_id, tr.company_id, 'training',
         tr.completed_on::timestamptz,
         tr.kind::text,
         tr.notes
    from public.employee_training_records tr
  union all
  select ech.employee_id, ech.company_id, 'posting',
         ech.changed_at,
         ('Code ' || coalesce(ech.old_code, '—') || ' → ' || coalesce(ech.new_code, '—')),
         ech.reason
    from public.employee_code_history ech
  union all
  select ae.employee_id, ae.company_id, 'approval',
         ae.changed_at,
         (coalesce(ae.from_state::text, '—') || ' → ' || ae.to_state::text),
         (ae.action || coalesce(' · ' || ae.reason, ''))
    from public.employee_approval_events ae;
