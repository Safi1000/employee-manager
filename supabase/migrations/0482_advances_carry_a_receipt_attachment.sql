-- 0482 — advances can carry a receipt/screenshot attachment.
--
-- Mirrors how cheques and cash_deposits already store an attachment: three
-- nullable text columns holding the Google Drive file id, its view URL, and the
-- original file name. The file is uploaded through the gdrive-upload edge function
-- and these columns are written by a post-create raw update on the row (same
-- pattern the cheque and deposit screens use) — record_advance is untouched and
-- no money path changes.
--
-- Idempotent: add-if-not-exists, so a replay is a no-op.

alter table public.advances
  add column if not exists drive_file_id        text,
  add column if not exists drive_view_url        text,
  add column if not exists attachment_file_name text;

-- TENANT GUARD ASSERTION: this migration adds only columns — no SECURITY DEFINER
-- function enters the executable-by-authenticated scan set — so the surface is
-- unchanged. Asserted empty regardless, so the file cannot pass while a gap exists.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0482 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
