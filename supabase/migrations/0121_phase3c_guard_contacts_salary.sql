-- 0121: Phase 3C — merged guard_contacts + salary-history extension (§3.3, §3.4).
--
-- Spec §12 ADDITIVE ONLY. Source columns/tables kept and backfilled FROM.
--   * guard_contacts: one table with a role enum merging Emergency Contact +
--     Second Emergency Contact + Next of Kin + Reference 1 + Reference 2. The
--     existing employee_references typed values (uc_gazetted / blood_relation)
--     are preserved in contact_subtype so no meaning is lost.
--   * employee_salary_history is EXTENDED (reuse, per confirmed policy) with a
--     structured reason enum + approved_by — NOT a new guard_salary_history
--     table; deployment_id is deferred to Phase 4 (deployments not built yet).
--   * Statutory Registrations block is a UI-only grouping of existing columns
--     (eobi_registration_number, social_security_*, insurance_*) — no schema.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname='guard_contact_role') then
    create type guard_contact_role as enum
      ('emergency_1','emergency_2','next_of_kin','reference_1','reference_2');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname='salary_change_reason') then
    create type salary_change_reason as enum
      ('probation','confirmed','increment','contract_revision','demotion');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. guard_contacts
-- ---------------------------------------------------------------------------
create table if not exists public.guard_contacts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  role            guard_contact_role not null,
  name            text,
  relation        text,
  contact         text,
  cnic            text,
  address         text,
  contact_subtype text,   -- preserves employee_references.reference_type (uc_gazetted / blood_relation)
  id_copy_ref     uuid references public.employee_documents(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (employee_id, role)
);

create index if not exists guard_contacts_company_idx  on public.guard_contacts(company_id);
create index if not exists guard_contacts_employee_idx on public.guard_contacts(employee_id);

drop trigger if exists trg_aaa_guard_contacts_fill_company on public.guard_contacts;
create trigger trg_aaa_guard_contacts_fill_company
  before insert on public.guard_contacts
  for each row execute function public.fill_company_id();

drop trigger if exists trg_guard_contacts_updated_at on public.guard_contacts;
create trigger trg_guard_contacts_updated_at
  before update on public.guard_contacts
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_guard_contacts_audit on public.guard_contacts;
create trigger trg_zzz_guard_contacts_audit
  after insert or update or delete on public.guard_contacts
  for each row execute function public.log_audit_change();

alter table public.guard_contacts enable row level security;

drop policy if exists "ssa_all" on public.guard_contacts;
create policy "ssa_all" on public.guard_contacts for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.guard_contacts;
create policy "company_members" on public.guard_contacts for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 3. Backfill guard_contacts from existing employee columns + references.
-- ---------------------------------------------------------------------------
insert into public.guard_contacts (company_id, employee_id, role, name, relation, contact)
select company_id, id, 'emergency_1', emergency_contact_name, emergency_contact_relation, emergency_contact_phone
from public.employees where emergency_contact_name is not null
on conflict (employee_id, role) do nothing;

insert into public.guard_contacts (company_id, employee_id, role, name, relation, contact)
select company_id, id, 'emergency_2', emergency_contact2_name, emergency_contact2_relation, emergency_contact2_phone
from public.employees where emergency_contact2_name is not null
on conflict (employee_id, role) do nothing;

insert into public.guard_contacts (company_id, employee_id, role, name, relation, cnic, contact)
select company_id, id, 'next_of_kin', next_of_kin_name, next_of_kin_relation, next_of_kin_cnic, next_of_kin_contact
from public.employees where next_of_kin_name is not null
on conflict (employee_id, role) do nothing;

-- References: map by type (uc_gazetted -> reference_1, blood_relation -> reference_2),
-- preserving the original type in contact_subtype. row_number guards the rare case
-- of two same-typed references for one employee.
insert into public.guard_contacts
  (company_id, employee_id, role, name, cnic, address, contact, contact_subtype, id_copy_ref, notes)
select r.company_id, r.employee_id,
  (case when r.reference_type::text = 'blood_relation' then 'reference_2' else 'reference_1' end)::guard_contact_role,
  r.name, r.cnic, r.address, r.contact, r.reference_type::text, r.id_copy_document_id, r.notes
from (
  select er.*, row_number() over (
    partition by er.employee_id,
      (case when er.reference_type::text='blood_relation' then 'reference_2' else 'reference_1' end)
    order by er.created_at) as rn
  from public.employee_references er
) r
where r.rn = 1
on conflict (employee_id, role) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Extend employee_salary_history (reuse, not a new table).
-- ---------------------------------------------------------------------------
alter table public.employee_salary_history
  add column if not exists salary_change_reason salary_change_reason,
  add column if not exists approved_by          uuid references auth.users(id) on delete set null;

comment on table public.employee_salary_history is
  '0121 §3.4: serves as guard_salary_history. Payroll reads the rate effective on each attendance date; per-day rate = rate / days_in_month at runtime (never stored). deployment_id deferred to Phase 4.';
