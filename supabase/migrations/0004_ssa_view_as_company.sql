-- ============================================================================
-- SSA "view as company": when profiles.view_as_company is set, SSA's
-- current_company_id() returns that value so the existing company_members
-- RLS policies scope the super-admin pages to that one tenant.
-- When NULL (default), SSA retains full cross-company access via is_ssa_unscoped().
-- ============================================================================

alter table public.profiles
  add column if not exists view_as_company uuid references public.companies(id) on delete set null;

alter table public.profiles drop constraint if exists view_as_only_for_ssa;
alter table public.profiles add constraint view_as_only_for_ssa check (
  role = 'super_super_admin' or view_as_company is null
);

create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(p.view_as_company, p.company_id)
  from public.profiles p
  where p.id = auth.uid()
$$;

create or replace function public.is_ssa_unscoped()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'super_super_admin'
      and view_as_company is null
  )
$$;

do $$
declare
  t text;
  per_company_tables text[] := array[
    'locations','clients','employees','attendance_records','employee_documents',
    'inventory_items','issuances','bank_accounts','treasury','bank_transactions',
    'expense_categories','vendors','expenses','invoices','invoice_payments',
    'payslips','advances','important_dates','recurring_alerts','notification_settings'
  ];
begin
  foreach t in array per_company_tables loop
    execute format('drop policy if exists "ssa_all" on public.%I', t);
    execute format($p$create policy "ssa_all" on public.%I for all
      using (public.is_ssa_unscoped())
      with check (public.is_ssa_unscoped())$p$, t);
  end loop;
end $$;

drop policy if exists "ssa_all" on public.companies;
create policy "ssa_all" on public.companies for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());

drop policy if exists "ssa_all_profiles" on public.profiles;
create policy "ssa_all_profiles" on public.profiles for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());

drop policy if exists "ssa_all" on public.company_counters;
create policy "ssa_all" on public.company_counters for all
  using (public.is_super_super_admin())
  with check (public.is_super_super_admin());
