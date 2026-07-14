-- 0066: Employee ↔ Contract Line assignment (Phase 4).
--
-- Ties an employee to a specific contract_line (category slot) with an
-- assignment-specific effective window, distinct from the general join_date.
-- We EXTEND employees (rather than add a parallel table) so the existing
-- "count active employees on this contract" logic keeps a single source of
-- truth — the same rows now also carry which line/category they fill.
--
-- Depends on 0063 (contract_lines).

alter table public.employees
  add column if not exists contract_line_id           uuid references public.contract_lines(id) on delete set null,
  add column if not exists assignment_effective_from  date,
  add column if not exists assignment_effective_to    date;

create index if not exists idx_employees_contract_line on public.employees(contract_line_id);

-- Backfill: for employees already tagged to a contract that has exactly ONE
-- line (the Phase-1 backfilled GUARD line), assign them to that line and seed
-- effective_from from their join date (falling back to the contract start).
-- Employees on contracts with multiple lines are LEFT UNASSIGNED (contract_line_id
-- stays null) — their category can't be inferred and must be set by hand.
update public.employees e
   set contract_line_id = single.line_id,
       assignment_effective_from = coalesce(e.join_date, single.start_date)
  from (
    select cl.contract_id,
           min(cl.id::text)::uuid as line_id,
           count(*)               as n,
           min(c.start_date)      as start_date
      from public.contract_lines cl
      join public.contracts c on c.id = cl.contract_id
     group by cl.contract_id
    having count(*) = 1
  ) single
 where e.contract_id = single.contract_id
   and e.contract_line_id is null;

-- REVIEW QUERY (no data change) — employees on a client contract but with no
-- line assignment (multi-line contracts, or contracts with no lines). Assign
-- these to a category slot by hand from the Employee modal.
--
--   select e.employee_code, e.full_name, c.contract_code
--   from public.employees e
--   join public.contracts c on c.id = e.contract_id
--   where e.contract_id is not null
--     and e.contract_line_id is null
--   order by c.contract_code, e.full_name;

-- employees is already in the audited-tables list (0041): assignment /
-- reassignment changes are captured in the Audit Log automatically.

 