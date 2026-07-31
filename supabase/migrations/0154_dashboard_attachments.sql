-- 0154: Dashboard attachments — a company-wide scratch board on the Dashboard.
--
-- Upload files / images or pin external links; everything is scoped to the
-- company and shared across its users. Purely a saved reference area on the
-- dashboard — NOT part of any Excel export or downstream calculation.
--
-- A row is either a link (url set) or a stored object (storage_path set, living
-- in the dashboard-attachments bucket created below).

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table if not exists public.dashboard_attachments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  kind          text not null check (kind in ('file', 'image', 'link')),
  title         text,
  url           text,          -- external link (kind='link'), else null
  file_name     text,          -- original filename (kind in file/image)
  storage_path  text,          -- path within the dashboard-attachments bucket
  mime_type     text,
  size_bytes    bigint,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint dashboard_attachments_target_ck check (
    (kind = 'link' and url is not null)
    or (kind in ('file', 'image') and storage_path is not null)
  )
);

create index if not exists dashboard_attachments_company_idx on public.dashboard_attachments(company_id);
create index if not exists dashboard_attachments_created_idx on public.dashboard_attachments(company_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Triggers (company scoping, updated_at, audit) — same convention as the
--    rest of the schema.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_aaa_dashboard_attachments_fill_company on public.dashboard_attachments;
create trigger trg_aaa_dashboard_attachments_fill_company
  before insert on public.dashboard_attachments
  for each row execute function public.fill_company_id();

drop trigger if exists trg_dashboard_attachments_updated_at on public.dashboard_attachments;
create trigger trg_dashboard_attachments_updated_at
  before update on public.dashboard_attachments
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_dashboard_attachments_audit on public.dashboard_attachments;
create trigger trg_zzz_dashboard_attachments_audit
  after insert or update or delete on public.dashboard_attachments
  for each row execute function public.log_audit_change();

-- ---------------------------------------------------------------------------
-- 3. RLS — SSA everywhere, otherwise scoped to the caller's company.
-- ---------------------------------------------------------------------------
alter table public.dashboard_attachments enable row level security;

drop policy if exists "ssa_all" on public.dashboard_attachments;
create policy "ssa_all" on public.dashboard_attachments for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.dashboard_attachments;
create policy "company_members" on public.dashboard_attachments for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 4. Storage bucket for the uploaded files/images. Public read (paths are
--    unguessable UUIDs) so image thumbnails and downloads resolve via
--    getPublicUrl, matching the app's other attachment buckets.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('dashboard-attachments', 'dashboard-attachments', true)
on conflict (id) do nothing;

drop policy if exists "dashboard_attachments_read" on storage.objects;
create policy "dashboard_attachments_read" on storage.objects for select
  to authenticated using (bucket_id = 'dashboard-attachments');

drop policy if exists "dashboard_attachments_insert" on storage.objects;
create policy "dashboard_attachments_insert" on storage.objects for insert
  to authenticated with check (bucket_id = 'dashboard-attachments');

drop policy if exists "dashboard_attachments_update" on storage.objects;
create policy "dashboard_attachments_update" on storage.objects for update
  to authenticated using (bucket_id = 'dashboard-attachments');

drop policy if exists "dashboard_attachments_delete" on storage.objects;
create policy "dashboard_attachments_delete" on storage.objects for delete
  to authenticated using (bucket_id = 'dashboard-attachments');
