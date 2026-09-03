-- 0344 — the eleven system expense categories come back.
--
-- WHAT WAS WRONG. GUARDS AND GUIDES (PVT) LTD held ZERO of the eleven
-- categories that src/app/lib/supabase.ts calls HARDCODED_EXPENSE_CATEGORIES.
-- Six user-made ones (Courier, GIFT, Maintainance, Refreshment, Stationary,
-- Travel Expense) were entered on 2026-09-03 into an otherwise empty list.
-- SHAYAN A., seeded 2026-09-02, still has all eleven — so this is GGS losing
-- its seed, not the seed being wrong.
--
-- WHY IT MATTERS, AND WHY IT IS NOT COSMETIC. These eleven names are not
-- suggestions. They are the join between an expense and its line on the
-- financial statements, and the join is BY NAME in three separate places:
--
--   1. public.map_expense_to_coa_key(cat_name, pl_category, client_id)
--      — the posting side. Nine of the eleven select a named GL account:
--
--        Equipment & Supplies   -> cos_equipment
--        Transportation & Fuel  -> cos_transport
--        EOBI / IESSI / PESSI   -> cos_statutory
--        Utilities & Rent       -> opex_utilities
--        Insurance              -> opex_insurance
--        Licenses               -> opex_licences
--        Taxes                  -> income_tax
--
--      Absent the row, the expense cannot carry the name, so it falls to the
--      `else` arm and posts to cos_other / opex_other. The journal balances.
--      Nothing raises. The money simply lands in the wrong account.
--
--   2. FinancialReports.tsx — the P&L reads the category NAME and routes it to
--      a fixed line "regardless of the pl_category stored on the expense".
--      Weapons & Ammunition and Uniform are named there too, into Other Direct
--      Costs, which is why all ELEVEN matter and not only the nine above.
--
--   3. CashFlow.tsx, same name tests, for the cash-basis P&L.
--
--   FinancialReports.tsx additionally looks up 'Weapons & Ammunition' and
--   'Uniform' BY ID for the chart series. With no row, the id is null and both
--   series read zero for every period — silently, since zero is a lawful total.
--
-- WHY THE UI DID NOT STOP THIS. Expenses.tsx refuses to delete or rename a
-- hardcoded category (isHardcodedCategory). Whatever removed GGS's rows did not
-- come through that dialog. The frontend guard is real but it is not the
-- database's, and expense_categories has no such constraint.
--
-- WHAT THIS MIGRATION DOES. Inserts any of the eleven that a company is
-- missing, for EVERY company, not only GGS — the same loss can have happened
-- anywhere and a company that already has them takes no change. Insert only:
--   * no existing category is renamed, moved or deleted
--   * no expense is re-pointed
--   * no journal entry is written, reversed or reposted
--
-- SAFE TO REPLAY. unique (company_id, name) + on conflict do nothing.
--
-- NOTE ON THE SIX GGS EXPENSES ALREADY POSTED. All six carry one of the
-- user-made categories, none of which is in this list and none of which maps to
-- a named key. Their postings are unaffected by this file and are NOT restated
-- here. If any of them should have been, say, Utilities & Rent, re-pointing the
-- expense is a separate, named decision — the trigger reposts on category_id
-- change and that is a journal write.

do $$
declare
  v_inserted int;
begin
  with names(name) as (values
    ('Weapons & Ammunition'),
    ('Uniform'),
    ('Equipment & Supplies'),
    ('Transportation & Fuel'),
    ('Utilities & Rent'),
    ('Insurance'),
    ('Licenses'),
    ('EOBI'),
    ('IESSI'),
    ('PESSI'),
    ('Taxes')
  ),
  ins as (
    insert into public.expense_categories (company_id, name)
    select c.id, n.name
      from public.companies c
     cross join names n
    on conflict (company_id, name) do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  raise notice '0344: restored % system expense category row(s).', v_inserted;

  -- The point of the file. If any company is still short one, the name-based
  -- routing above is still broken for it and this must not report success.
  if exists (
    select 1
      from public.companies c
     cross join (values
       ('Weapons & Ammunition'),('Uniform'),('Equipment & Supplies'),
       ('Transportation & Fuel'),('Utilities & Rent'),('Insurance'),
       ('Licenses'),('EOBI'),('IESSI'),('PESSI'),('Taxes')
     ) as n(name)
     where not exists (
       select 1 from public.expense_categories ec
        where ec.company_id = c.id and ec.name = n.name
     )
  ) then
    raise exception
      '0344 FAILED: at least one company is still missing a system expense category. Expense postings for it route by NAME (map_expense_to_coa_key) and will land in cos_other/opex_other without raising.';
  end if;
end $$;
