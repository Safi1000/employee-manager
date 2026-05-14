-- ============================================================================
-- ADDITIVE migration. No data loss.
-- 1) branches + branch_id on clients/employees/profiles. Head Office seeded.
-- 2) employees.category + nullable client_id.
-- 3) cheques + cheque_id on expenses/advances/payslips/invoice_payments;
--    payment_mode CHECKs expanded to include 'Cheque'.
-- 4) clients gain auto-invoice fields.
-- 5) Branch RLS helpers + restrictive branch_scope policies.
-- ============================================================================

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  is_head_office boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name)
);

alter table public.branches enable row level security;
drop policy if exists "ssa_all" on public.branches;
create policy "ssa_all" on public.branches for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.branches;
create policy "company_members" on public.branches for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

drop trigger if exists trg_branches_updated_at on public.branches;
create trigger trg_branches_updated_at before update on public.branches
  for each row execute function public.set_updated_at();
drop trigger if exists trg_aaa_branches_fill_company on public.branches;
create trigger trg_aaa_branches_fill_company before insert on public.branches
  for each row execute function public.fill_company_id();

create or replace function public.seed_head_office()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.branches (company_id, name, is_head_office)
  values (new.id, 'Head Office', true)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists trg_company_head_office on public.companies;
create trigger trg_company_head_office after insert on public.companies
  for each row execute function public.seed_head_office();

insert into public.branches (company_id, name, is_head_office)
select c.id, 'Head Office', true
from public.companies c
where not exists (
  select 1 from public.branches b
  where b.company_id = c.id and b.is_head_office = true
);

alter table public.clients add column if not exists branch_id uuid references public.branches(id) on delete set null;
alter table public.employees add column if not exists branch_id uuid references public.branches(id) on delete set null;
alter table public.profiles add column if not exists branch_id uuid references public.branches(id) on delete set null;

update public.clients c
set branch_id = b.id
from public.branches b
where b.company_id = c.company_id and b.is_head_office = true and c.branch_id is null;

update public.employees e
set branch_id = b.id
from public.branches b
where b.company_id = e.company_id and b.is_head_office = true and e.branch_id is null;

do $$ begin
  create type public.employee_category as enum ('client', 'office_staff', 'reliever');
exception when duplicate_object then null; end $$;

alter table public.employees add column if not exists category public.employee_category not null default 'client';
alter table public.employees alter column client_id drop not null;

create table if not exists public.cheques (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  cheque_number text not null,
  amount numeric(14,2) not null check (amount > 0),
  cheque_date date not null,
  status text not null default 'pending' check (status in ('pending','cleared')),
  attachment_path text,
  notes text,
  recipient text,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cheques enable row level security;
drop policy if exists "ssa_all" on public.cheques;
create policy "ssa_all" on public.cheques for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists "company_members" on public.cheques;
create policy "company_members" on public.cheques for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

drop trigger if exists trg_cheques_updated_at on public.cheques;
create trigger trg_cheques_updated_at before update on public.cheques
  for each row execute function public.set_updated_at();
drop trigger if exists trg_aaa_cheques_fill_company on public.cheques;
create trigger trg_aaa_cheques_fill_company before insert on public.cheques
  for each row execute function public.fill_company_id();

alter table public.expenses add column if not exists cheque_id uuid references public.cheques(id) on delete set null;
alter table public.advances add column if not exists cheque_id uuid references public.cheques(id) on delete set null;
alter table public.payslips add column if not exists cheque_id uuid references public.cheques(id) on delete set null;
alter table public.invoice_payments add column if not exists cheque_id uuid references public.cheques(id) on delete set null;

do $$
declare rec record;
begin
  for rec in
    select 'expenses'::text as t, array['Cash','Bank','Cheque','Payable']::text[] as allowed
    union all select 'advances'::text, array['Cash','Bank','Cheque']::text[]
    union all select 'payslips'::text, array['Cash','Bank','Cheque']::text[]
    union all select 'invoice_payments'::text, array['Cash','Bank','Cheque']::text[]
  loop
    execute format('alter table public.%I drop constraint if exists %I', rec.t, rec.t || '_payment_mode_check');
    execute format('alter table public.%I add constraint %I check (payment_mode = any (%L::text[]))',
                   rec.t, rec.t || '_payment_mode_check', rec.allowed);
  end loop;
end $$;

alter table public.clients add column if not exists auto_invoice_enabled boolean not null default false;
alter table public.clients add column if not exists auto_invoice_amount numeric(14,2) not null default 0 check (auto_invoice_amount >= 0);
alter table public.clients add column if not exists contract_start date;
alter table public.clients add column if not exists contract_end date;
alter table public.clients add column if not exists advance_payment boolean not null default false;

create or replace function public.current_branch_id()
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_branched_user()
returns boolean language sql stable security definer set search_path = public as $$
  select (select branch_id from public.profiles where id = auth.uid()) is not null
$$;

drop policy if exists "branch_scope" on public.clients;
create policy "branch_scope" on public.clients as restrictive for all
  using (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin())
  with check (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin());

drop policy if exists "branch_scope" on public.employees;
create policy "branch_scope" on public.employees as restrictive for all
  using (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin())
  with check (not public.is_branched_user() or branch_id = public.current_branch_id() or public.is_super_super_admin());

do $$
declare t text;
begin
  foreach t in array array['attendance_records', 'employee_documents', 'payslips', 'advances']
  loop
    execute format('drop policy if exists "branch_scope" on public.%I', t);
    execute format(
      'create policy "branch_scope" on public.%I as restrictive for all
         using (not public.is_branched_user() or public.is_super_super_admin()
                or exists (select 1 from public.employees e where e.id = %I.employee_id and e.branch_id = public.current_branch_id()))
         with check (not public.is_branched_user() or public.is_super_super_admin()
                or exists (select 1 from public.employees e where e.id = %I.employee_id and e.branch_id = public.current_branch_id()))',
      t, t, t);
  end loop;
end $$;

drop policy if exists "branch_scope" on public.invoices;
create policy "branch_scope" on public.invoices as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or exists (select 1 from public.clients c where c.id = invoices.client_id and c.branch_id = public.current_branch_id()))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or exists (select 1 from public.clients c where c.id = invoices.client_id and c.branch_id = public.current_branch_id()));

drop policy if exists "branch_scope" on public.invoice_payments;
create policy "branch_scope" on public.invoice_payments as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or (invoice_payments.client_id is not null and exists (select 1 from public.clients c where c.id = invoice_payments.client_id and c.branch_id = public.current_branch_id()))
    or (invoice_payments.invoice_id is not null and exists (select 1 from public.invoices i join public.clients c on c.id = i.client_id where i.id = invoice_payments.invoice_id and c.branch_id = public.current_branch_id())))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or (invoice_payments.client_id is not null and exists (select 1 from public.clients c where c.id = invoice_payments.client_id and c.branch_id = public.current_branch_id()))
    or (invoice_payments.invoice_id is not null and exists (select 1 from public.invoices i join public.clients c on c.id = i.client_id where i.id = invoice_payments.invoice_id and c.branch_id = public.current_branch_id())));

drop policy if exists "branch_scope" on public.expenses;
create policy "branch_scope" on public.expenses as restrictive for all
  using (not public.is_branched_user() or public.is_super_super_admin()
    or expenses.client_id is null
    or exists (select 1 from public.clients c where c.id = expenses.client_id and c.branch_id = public.current_branch_id()))
  with check (not public.is_branched_user() or public.is_super_super_admin()
    or expenses.client_id is null
    or exists (select 1 from public.clients c where c.id = expenses.client_id and c.branch_id = public.current_branch_id()));
