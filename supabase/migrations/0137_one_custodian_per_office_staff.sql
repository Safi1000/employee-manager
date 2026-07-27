-- 0137: One custodian cash-location per office-staff member.
--
-- The Add-Location form let each custodian be given a free-text name, so the same
-- office-staff person (e.g. Kashif) ended up with several custodian locations
-- ("a", "Aa", "Cash deposit"). A custodian IS an office-staff member, so there must
-- be exactly one location per employee, named after them, holding their total cash.
--
-- This migration: (1) merges duplicate custodian locations per employee — summing
-- opening balances and re-pointing every attributed payment/expense/transfer onto a
-- single surviving row, then deleting the extras; (2) renames every custodian
-- location to its office-staff member; (3) adds a unique index so duplicates can
-- never be created again. Non-employee cash boxes (custodian_employee_id IS NULL)
-- and bank/treasury rows are untouched.

do $$
declare
  rec record;
  surv uuid;
  extra numeric;
begin
  for rec in
    select company_id, custodian_employee_id
    from public.cash_locations
    where custodian_employee_id is not null and location_type = 'CUSTODIAN'
    group by company_id, custodian_employee_id
    having count(*) > 1
  loop
    -- Survivor: the row with the most attached history, oldest as tie-breaker.
    select cl.id into surv
    from public.cash_locations cl
    where cl.company_id = rec.company_id
      and cl.custodian_employee_id = rec.custodian_employee_id
      and cl.location_type = 'CUSTODIAN'
    order by (
        (select count(*) from public.expenses x where x.custodian_location_id = cl.id)
      + (select count(*) from public.invoice_payments p where p.custodian_location_id = cl.id)
      + (select count(*) from public.custody_transfers t where t.from_location_id = cl.id or t.to_location_id = cl.id)
    ) desc, cl.created_at asc
    limit 1;

    -- Fold the non-survivors' opening balances into the survivor.
    select coalesce(sum(opening_balance), 0) into extra
    from public.cash_locations
    where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
      and location_type = 'CUSTODIAN' and id <> surv;
    update public.cash_locations set opening_balance = opening_balance + extra where id = surv;

    -- Re-point every reference off the duplicates onto the survivor.
    update public.expenses set custodian_location_id = surv
      where custodian_location_id in (
        select id from public.cash_locations
        where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
          and location_type = 'CUSTODIAN' and id <> surv);
    update public.invoice_payments set custodian_location_id = surv
      where custodian_location_id in (
        select id from public.cash_locations
        where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
          and location_type = 'CUSTODIAN' and id <> surv);
    update public.custody_transfers set from_location_id = surv
      where from_location_id in (
        select id from public.cash_locations
        where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
          and location_type = 'CUSTODIAN' and id <> surv);
    update public.custody_transfers set to_location_id = surv
      where to_location_id in (
        select id from public.cash_locations
        where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
          and location_type = 'CUSTODIAN' and id <> surv);

    -- Remove the now-unreferenced duplicates.
    delete from public.cash_locations
    where company_id = rec.company_id and custodian_employee_id = rec.custodian_employee_id
      and location_type = 'CUSTODIAN' and id <> surv;
  end loop;
end $$;

-- Every custodian location is named after its office-staff member.
update public.cash_locations cl
set name = e.full_name
from public.employees e
where e.id = cl.custodian_employee_id and cl.location_type = 'CUSTODIAN';

-- Enforce one custodian location per office-staff member from here on.
create unique index if not exists cash_locations_one_custodian_per_employee
  on public.cash_locations (company_id, custodian_employee_id)
  where custodian_employee_id is not null and location_type = 'CUSTODIAN';
