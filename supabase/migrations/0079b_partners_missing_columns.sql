-- 0079b: Columns on `partners` that exist in production but were added
-- directly in the SQL editor and never captured as a migration. 0080 onwards
-- reference partners.branch_id / scope / allocation_method, so a from-scratch
-- database needs them here. Types, defaults and CHECKs mirror production.

alter table public.partners
  add column if not exists scope text not null default 'COMPANY',
  add column if not exists branch_id uuid references public.branches(id),
  add column if not exists allocation_method text not null default 'MANUAL',
  add column if not exists default_share_pct numeric(5,2),
  add column if not exists linked_user_id uuid references public.profiles(id),
  add column if not exists opening_balance_date date,
  add column if not exists is_active boolean not null default true;

alter table public.partners drop constraint if exists partners_scope_check;
alter table public.partners add constraint partners_scope_check
  check (scope in ('COMPANY', 'BRANCH'));

alter table public.partners drop constraint if exists partners_allocation_method_check;
alter table public.partners add constraint partners_allocation_method_check
  check (allocation_method in ('FIXED_PCT', 'MANUAL'));
