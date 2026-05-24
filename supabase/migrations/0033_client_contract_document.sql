-- Lets each client carry an uploaded contract PDF/scan on Google Drive.
-- Three columns mirror what employee_documents already does for employee docs:
--   contract_drive_file_id : Drive file ID (for delete / re-fetch by ID)
--   contract_drive_view_url: webViewLink rendered as a "View contract" button
--   contract_file_name     : original filename, shown in the UI
alter table public.clients
  add column if not exists contract_drive_file_id  text null,
  add column if not exists contract_drive_view_url text null,
  add column if not exists contract_file_name      text null;
