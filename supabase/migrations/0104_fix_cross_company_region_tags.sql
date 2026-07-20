-- Data-integrity fix: cross-company region tags on expenses.
--
-- Surfaced by the §8 cash-entitlement view: ~10 GuardsAndGuides expenses (no
-- client) carried a branch_id belonging to ANOTHER company (a DEMO CRM branch)
-- from before the region model existed. The §1 expense-inheritance trigger
-- trusts an explicitly-set branch when there is no client, so it faithfully
-- preserved the bad value — and those expenses' journal lines were tagged to a
-- foreign region, splitting one company's cash across two "Head Office" rows.
--
-- Fix: never trust a foreign-company branch. Harden the three inheritance
-- triggers that fall back on new.branch_id, then re-point the affected rows to
-- their own head office (which reverse-and-reposts their journals correctly).

-- A branch is only usable as a row's region if it belongs to the row's company.
create or replace function public.same_company_branch(p_company_id uuid, p_branch_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select case
    when p_branch_id is not null
     and exists (select 1 from public.branches
                  where id = p_branch_id and company_id = p_company_id)
    then p_branch_id else null end;
$$;

-- Harden the inheritance functions that trust new.branch_id: sanitise it first.
create or replace function public.inherit_region_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

create or replace function public.inherit_region_advance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_employee(new.employee_id),
    public.region_for_client(new.client_id),
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

create or replace function public.inherit_region_cheque()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select i.branch_id into v_region from public.invoices i where i.id = new.invoice_id;
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    v_region,
    public.same_company_branch(new.company_id, new.branch_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

-- Re-point the affected expenses to their own head office. Setting branch_id
-- fires journal_on_expense (branch changed -> reverse old journal + repost with
-- the correct region), so the ledger tags heal too.
update public.expenses e
   set branch_id = public.head_office_region(e.company_id), updated_at = now()
 where exists (select 1 from public.branches b
                where b.id = e.branch_id and b.company_id <> e.company_id);

-- The expense update above reverse-and-reposts, but the original wrong entries
-- and their reversals stay on the ledger still tagged to the foreign branch
-- (netting to zero, yet showing as a phantom region). A wrong region tag isn't
-- a real historical event to preserve, so re-tag any remaining cross-company
-- journal line to its entry's own head office. Net balances are unchanged;
-- only the (previously foreign) region label is corrected.
update public.journal_lines jl
   set branch_id = public.head_office_region(je.company_id)
  from public.journal_entries je
  join public.branches b2 on true
 where jl.journal_entry_id = je.id
   and b2.id = jl.branch_id
   and b2.company_id <> je.company_id;
