-- ============================================================================
-- Per-company dashboard customization: which widgets are HIDDEN.
-- Default '[]' means show everything. Keys mirror the Dashboard.tsx widgets:
--   stat_employees, stat_attendance_today, stat_expenses_mtd, stat_payroll_mtd,
--   bank_overview, top_clients, attendance_trend, compliance_alerts
-- ============================================================================

alter table public.companies
  add column if not exists dashboard_hidden_widgets jsonb not null default '[]'::jsonb;
