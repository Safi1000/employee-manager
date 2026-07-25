-- 0120: Phase 3B — unified guard_documents register (§3.5).
--
-- One row per (guard, document). Replaces the four parallel systems for READ
-- purposes: Documents Checklist (employee_document_checklist), Licences &
-- Compliance (licence fields on employees), Vetting, and Physical-Copy-Present.
-- Spec §12 ADDITIVE ONLY: the source tables/columns are NOT dropped — they are
-- backfilled FROM and later hidden. Readers (armed-post block, compliance
-- calendar, completeness badges) are repointed to this table in a later verified
-- step within Phase 3, not here.
--
-- Confirmed decisions (Phase 3B):
--   * doc_type = the spec's 20 canonical values; checklist 'photographs' maps to
--     'photograph' and 'id_copies' to 'cnic_copy'.
--   * Backfill status: verified_by set => 'verified'; received => 'on_file';
--     else 'missing'. Licence docs with a past expiry => 'expired'.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname='guard_doc_type') then
    create type guard_doc_type as enum (
      'cnic_copy','photograph','police_verification','character_certificate',
      'halaf_nama','medical_certificate','education_certificate','discharge_certificate',
      'pension_book','utility_bill','biometrics','reference_1_cnic','reference_2_cnic',
      'signed_data_form','weapon_licence','guard_service_licence','appointment_letter',
      'deduction_authority','kit_acknowledgment','discharge_sheet');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname='guard_doc_status') then
    create type guard_doc_status as enum
      ('missing','pending','on_file','verified','expired','waived');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------
create table if not exists public.guard_documents (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  employee_id           uuid not null references public.employees(id) on delete cascade,
  doc_type              guard_doc_type not null,
  doc_number            text,
  issue_date            date,
  expiry_date           date,
  status                guard_doc_status not null default 'missing',
  waiver_reason         text,
  waiver_approved_by    uuid references auth.users(id) on delete set null,
  physical_copy_on_file boolean not null default false,
  file_ref              uuid references public.employee_documents(id) on delete set null,
  notes                 text,
  -- Extra (beyond spec list) to preserve the checklist's verification attribution
  -- rather than lose it — additive, harmless.
  verified_by           uuid references auth.users(id) on delete set null,
  verified_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (employee_id, doc_type)
);

create index if not exists guard_documents_company_idx  on public.guard_documents(company_id);
create index if not exists guard_documents_employee_idx on public.guard_documents(employee_id);
create index if not exists guard_documents_type_idx     on public.guard_documents(doc_type);
create index if not exists guard_documents_expiry_idx   on public.guard_documents(expiry_date) where expiry_date is not null;

drop trigger if exists trg_aaa_guard_documents_fill_company on public.guard_documents;
create trigger trg_aaa_guard_documents_fill_company
  before insert on public.guard_documents
  for each row execute function public.fill_company_id();

drop trigger if exists trg_guard_documents_updated_at on public.guard_documents;
create trigger trg_guard_documents_updated_at
  before update on public.guard_documents
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_guard_documents_audit on public.guard_documents;
create trigger trg_zzz_guard_documents_audit
  after insert or update or delete on public.guard_documents
  for each row execute function public.log_audit_change();

alter table public.guard_documents enable row level security;

drop policy if exists "ssa_all" on public.guard_documents;
create policy "ssa_all" on public.guard_documents for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.guard_documents;
create policy "company_members" on public.guard_documents for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. Backfill A — from employee_document_checklist (4,720 rows).
-- ---------------------------------------------------------------------------
insert into public.guard_documents
  (company_id, employee_id, doc_type, status, file_ref, notes, verified_by, verified_at)
select
  ch.company_id, ch.employee_id,
  (case ch.doc_type::text
     when 'photographs' then 'photograph'
     when 'id_copies'   then 'cnic_copy'
     else ch.doc_type::text
   end)::guard_doc_type,
  (case
     when ch.received and ch.verified_by is not null then 'verified'
     when ch.received then 'on_file'
     else 'missing'
   end)::guard_doc_status,
  ch.document_id, ch.notes, ch.verified_by, ch.verified_at
from public.employee_document_checklist ch
on conflict (employee_id, doc_type) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Backfill B — licence docs from employee fields (upsert to enrich).
--    weapon_licence + guard_service_licence are new types (insert); status
--    'expired' when the expiry is past, else 'on_file' when a number exists.
-- ---------------------------------------------------------------------------
insert into public.guard_documents
  (company_id, employee_id, doc_type, doc_number, expiry_date, status)
select e.company_id, e.id, 'weapon_licence', e.weapon_licence_number, e.weapon_licence_expiry,
  (case when e.weapon_licence_expiry is not null and e.weapon_licence_expiry < current_date then 'expired'
        when e.weapon_licence_number is not null then 'on_file' else 'missing' end)::guard_doc_status
from public.employees e
where e.weapon_licence_number is not null or e.weapon_licence_expiry is not null
on conflict (employee_id, doc_type) do update
  set doc_number = excluded.doc_number, expiry_date = excluded.expiry_date, status = excluded.status;

insert into public.guard_documents
  (company_id, employee_id, doc_type, doc_number, expiry_date, status)
select e.company_id, e.id, 'guard_service_licence', e.guard_service_licence_number, e.guard_service_licence_expiry,
  (case when e.guard_service_licence_expiry is not null and e.guard_service_licence_expiry < current_date then 'expired'
        when e.guard_service_licence_number is not null then 'on_file' else 'missing' end)::guard_doc_status
from public.employees e
where e.guard_service_licence_number is not null or e.guard_service_licence_expiry is not null
on conflict (employee_id, doc_type) do update
  set doc_number = excluded.doc_number, expiry_date = excluded.expiry_date, status = excluded.status;

-- ---------------------------------------------------------------------------
-- 5. Backfill C — enrich medical_certificate rows with medical_fitness_expiry
--    (the checklist row already exists; add expiry + expire if past).
-- ---------------------------------------------------------------------------
update public.guard_documents gd
set expiry_date = e.medical_fitness_expiry,
    status = case
      when e.medical_fitness_expiry is not null and e.medical_fitness_expiry < current_date then 'expired'::guard_doc_status
      else gd.status
    end
from public.employees e
where gd.employee_id = e.id
  and gd.doc_type = 'medical_certificate'
  and e.medical_fitness_expiry is not null;
