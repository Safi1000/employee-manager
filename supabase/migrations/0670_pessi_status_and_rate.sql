-- 0670 — PESSI: who is registered, and the per-head rate.
--
-- Bastion held nothing for PESSI (13 Nov 2026): no rate, no per-person status,
-- and every payment went in as an ordinary expense. GGS pays PESSI Taxila for
-- the workers PESSI lists as ACTIVE (20 for October 2026: 48,020 on voucher
-- 2611007106 = 2,401 a head). This adds:
--
--   1. employees.pessi_status — 'active' | 'inactive', as PESSI's own list
--      shows the worker; empty = not registered. The PESSI challan (Statutory →
--      PESSI / IESSI) lists the active ones to tick. Edited on the employee form
--      beside the EOBI fields (same commit). Statuses are filled from PESSI's
--      list by a data fix kept outside git (R2).
--   2. The PESSI rate: 0 employee + 2,401 employer per head from October 2026,
--      through change_statutory_rate (the one writer). Payroll withholds no
--      PESSI (DECIDED 22 Oct 2026): the whole amount is employer cost.
--
-- DEFERRED (owed, with EOBI's): recording a challan per person when paid, with
-- the cost on each worker's client (office staff on head office). People paid
-- for who are not in Bastion are entered on the challan as "others".

alter table public.employees add column if not exists pessi_status text;
alter table public.employees drop constraint if exists employees_pessi_status_check;
alter table public.employees add constraint employees_pessi_status_check
  check (pessi_status is null or pessi_status in ('active', 'inactive'));
comment on column public.employees.pessi_status is
  '0670: PESSI registration as PESSI''s list shows it — active | inactive; null = not registered. The PESSI challan lists the active ones. Edited on the employee form.';

do $$
begin
  if not exists (select 1 from public.statutory_rates
                  where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and scheme = 'pessi' and effective_from = '2026-10-01') then
    perform public.change_statutory_rate('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'pessi', 0, 2401, '2026-10-01',
      'PESSI Taxila: 48,020 for 20 workers, October 2026 (voucher 2611007106) — 0670');
  end if;
end $$;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'employees' and column_name = 'pessi_status') then
    raise exception '0670 FAILED: employees.pessi_status is missing.';
  end if;
  if not exists (select 1 from public.statutory_rates
                  where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and scheme = 'pessi'
                    and effective_from = '2026-10-01' and employee_amount = 0 and employer_amount = 2401) then
    raise exception '0670 FAILED: the PESSI rate 0 + 2,401 from October 2026 is not in place.';
  end if;
end $$;