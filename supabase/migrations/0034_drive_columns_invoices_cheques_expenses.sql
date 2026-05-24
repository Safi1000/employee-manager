-- New uploads for invoices, cheques and expenses land on Google Drive.
-- Existing rows with attachment_path / receipt_path stay on Supabase Storage
-- and the UI falls back to them when the Drive columns are null.
alter table public.invoices
  add column if not exists drive_file_id        text null,
  add column if not exists drive_view_url       text null,
  add column if not exists attachment_file_name text null;

alter table public.cheques
  add column if not exists drive_file_id        text null,
  add column if not exists drive_view_url       text null,
  add column if not exists attachment_file_name text null;

alter table public.expenses
  add column if not exists drive_file_id        text null,
  add column if not exists drive_view_url       text null,
  add column if not exists receipt_file_name    text null;
