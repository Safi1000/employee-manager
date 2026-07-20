-- Employee Data Form — full paper-form capture (spec section 11).
--
-- "Capture ALL paper-form fields in the employee record." Roughly half already
-- exist (cnic_number, date_of_birth, father_or_husband_name, blood_group,
-- addresses, one emergency contact, EOBI no, weapon licences, probation, exit
-- date). This adds the rest: the header, the personal/political/family/
-- ex-service blocks, a second emergency contact, and the internal office data.
-- Repeating sections (children, two references, previous jobs, the documents
-- checklist) become child tables so the form's rows aren't crammed into arrays.

do $$ begin
  create type public.marital_status as enum ('single', 'married', 'divorced', 'widowed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_security_status as enum ('registered', 'not_registered', 'exempt');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 1. Scalar form fields on the employee record
-- ---------------------------------------------------------------------------

alter table public.employees
  -- Header
  add column if not exists interview_date        date,
  add column if not exists form_serial_no        text,
  add column if not exists photo_url              text,
  -- Personal
  add column if not exists cnic_expiry            date,
  add column if not exists education              text,
  add column if not exists marital_status         public.marital_status,
  add column if not exists height_cm              numeric(5,1),
  add column if not exists weight_kg              numeric(5,1),
  add column if not exists build                  text,
  add column if not exists uniform_size           text,
  add column if not exists shoe_size              text,
  add column if not exists special_skills         text,
  -- Second emergency contact (the first already exists as emergency_contact_*)
  add column if not exists emergency_contact2_name     text,
  add column if not exists emergency_contact2_relation text,
  add column if not exists emergency_contact2_phone    text,
  -- Political / locality
  add column if not exists post_office            text,
  add column if not exists police_station         text,
  add column if not exists area_nazim             text,
  add column if not exists union_council          text,
  -- Family
  add column if not exists spouse_name            text,
  add column if not exists next_of_kin_name       text,
  add column if not exists next_of_kin_relation   text,
  add column if not exists next_of_kin_cnic       text,
  add column if not exists next_of_kin_contact    text,
  -- Ex-service
  add column if not exists is_ex_serviceman       boolean not null default false,
  add column if not exists army_number            text,
  add column if not exists service_unit           text,
  add column if not exists service_rank           text,
  add column if not exists service_trade          text,
  add column if not exists service_join_date      date,
  add column if not exists service_discharge_date date,
  add column if not exists discharging_officer    text,
  -- Experience
  add column if not exists weapons_trained        text,
  -- Internal office data
  add column if not exists designation            text,
  add column if not exists project                text,
  add column if not exists company_id_card_number text,
  add column if not exists social_security_status public.social_security_status,
  add column if not exists social_security_number text,
  add column if not exists insurance_provider     text,
  add column if not exists insurance_number       text,
  add column if not exists remarks                text,
  -- PDF flow: "Form signed on [date]" flag
  add column if not exists form_signed_on         date;

-- ---------------------------------------------------------------------------
-- 2. Repeating sections as child tables
-- ---------------------------------------------------------------------------

create table if not exists public.employee_children (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  name          text not null,
  date_of_birth date,
  gender        text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ec_employee on public.employee_children(employee_id);

do $$ begin
  create type public.reference_type as enum ('uc_gazetted', 'blood_relation');
exception when duplicate_object then null; end $$;

create table if not exists public.employee_references (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  employee_id      uuid not null references public.employees(id) on delete cascade,
  reference_type   public.reference_type not null,
  name             text not null,
  cnic             text,
  address          text,
  contact          text,
  id_copy_document_id uuid references public.employee_documents(id),
  notes            text,
  created_at       timestamptz not null default now(),
  -- One of each type per employee (spec: references x2 — one UC/gazetted, one
  -- blood relation).
  unique (employee_id, reference_type)
);
create index if not exists idx_er_employee on public.employee_references(employee_id);

create table if not exists public.employee_previous_jobs (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  employee_id        uuid not null references public.employees(id) on delete cascade,
  seq                integer not null check (seq between 1 and 3),
  employer           text,
  designation        text,
  from_date          date,
  to_date            date,
  reason_for_leaving text,
  created_at         timestamptz not null default now(),
  unique (employee_id, seq)
);
create index if not exists idx_epj_employee on public.employee_previous_jobs(employee_id);

-- Documents checklist. The 10 items the form lists become a fixed enum, and
-- every employee gets one row per item so "what's still missing" is a plain
-- query rather than an inference from absence.
do $$ begin
  create type public.checklist_doc_type as enum (
    'police_verification', 'medical_certificate', 'halaf_nama', 'photographs',
    'education_certificate', 'discharge_certificate', 'pension_book',
    'id_copies', 'biometrics', 'utility_bill');
exception when duplicate_object then null; end $$;

create table if not exists public.employee_document_checklist (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  doc_type      public.checklist_doc_type not null,
  received      boolean not null default false,
  document_id   uuid references public.employee_documents(id),
  verified_by   uuid,
  verified_at   timestamptz,
  notes         text,
  unique (employee_id, doc_type)
);
create index if not exists idx_edc_employee on public.employee_document_checklist(employee_id);

-- ---------------------------------------------------------------------------
-- 3. Company autofill + RLS for the child tables
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'employee_children', 'employee_references', 'employee_previous_jobs',
    'employee_document_checklist'
  ] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$s', t);
    execute format(
      'create trigger trg_aaa_%1$s_fill_company before insert on public.%1$s
         for each row execute function public.fill_company_id()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%1$s', t);
    execute format(
      'create policy "ssa_all" on public.%1$s for all
         using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%1$s', t);
    execute format(
      'create policy "company_members" on public.%1$s for all
         using (company_id = public.current_company_id())
         with check (company_id = public.current_company_id())', t);
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 4. Seed the documents checklist for every employee, and keep it seeded for
--    new hires. A checklist is only useful if all its items exist.
-- ---------------------------------------------------------------------------

create or replace function public.seed_document_checklist(p_employee_id uuid, p_company_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.employee_document_checklist (company_id, employee_id, doc_type)
  select p_company_id, p_employee_id, dt
    from unnest(enum_range(null::public.checklist_doc_type)) dt
  on conflict (employee_id, doc_type) do nothing;
$$;

create or replace function public.seed_document_checklist_on_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_document_checklist(new.id, new.company_id);
  return null;
end;
$$;

drop trigger if exists trg_emp_seed_checklist on public.employees;
create trigger trg_emp_seed_checklist
  after insert on public.employees
  for each row execute function public.seed_document_checklist_on_insert();

-- Backfill the 447 existing employees.
do $$
declare e record;
begin
  for e in select id, company_id from public.employees loop
    perform public.seed_document_checklist(e.id, e.company_id);
  end loop;
end$$;
