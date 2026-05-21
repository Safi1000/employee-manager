-- ============================================================================
-- Employee docs move from Supabase Storage to Google Drive.
-- Two new columns hold the Drive file ID + view URL. storage_path is kept
-- nullable so legacy rows (uploaded before the cutover) still resolve via
-- Supabase Storage; new uploads leave it NULL and populate drive_file_id.
-- The migration script (when run) will backfill old rows.
-- ============================================================================

alter table public.employee_documents
  add column if not exists drive_file_id text,
  add column if not exists drive_view_url text;

-- storage_path is now optional (either Supabase storage_path OR drive_file_id
-- must be set, but we don't enforce that at the DB level — frontend handles
-- read fallbacks).
alter table public.employee_documents
  alter column storage_path drop not null;

create index if not exists employee_documents_drive_file_idx
  on public.employee_documents(drive_file_id);
