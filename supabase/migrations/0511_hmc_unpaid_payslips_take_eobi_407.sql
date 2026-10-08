-- 0511 — every unpaid HMC Taxila payslip deducts EOBI at 407.
--
-- Asked 2026-10-08: "make the change to 407 for everyone". 0510 set HMC's EOBI
-- to 407; payslips saved before it kept 400 until saved again. Five September
-- payslips were saved at 09:07–09:08 UTC, before 0510, and never after.
--
-- Unpaid payslips only. A disbursed payslip keeps the EOBI it was paid against
-- (August, 400) — restating it would make the record disagree with the money
-- that left. Net is recomputed exactly as the payroll screen does it; the
-- accrual journal re-posts itself through journal_on_payslip when eobi moves.

do $mig$
declare
  c_hmc uuid := 'bb468666-1dd3-4efe-84ca-6ca890c3a6f5';  -- HMC Taxila
  v_n   int;
begin
  select count(*) into v_n
    from public.payslips p
    join public.employees e on e.id = p.employee_id
   where e.client_id = c_hmc and not p.disbursed and p.eobi is distinct from 407
     and round(coalesce(p.amount_paid, 0)) >
         greatest(0, round(p.final_salary - coalesce(p.income_tax, 0) - 407
                           - coalesce(p.advance, 0) + coalesce(p.adjustment_carried, 0)));
  if v_n > 0 then
    raise exception '0511: % unpaid HMC payslip(s) have already been paid more than their Net at 407. Nothing changed.', v_n;
  end if;

  update public.payslips p
     set eobi = 407,
         net_salary = greatest(0, round(p.final_salary - coalesce(p.income_tax, 0) - 407
                                        - coalesce(p.advance, 0) + coalesce(p.adjustment_carried, 0))),
         updated_at = now()
    from public.employees e
   where e.id = p.employee_id
     and e.client_id = c_hmc
     and not p.disbursed
     and p.eobi is distinct from 407;
end $mig$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0511 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
