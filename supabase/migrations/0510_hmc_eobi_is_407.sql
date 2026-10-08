-- 0510 — HMC Taxila's EOBI deduction is PKR 407.
--
-- DECIDED (2026-10-08, Shayan): "in HMC make EOBI deduction 407 rs".
--
-- The figure payroll withholds is the contract's (resolveEobiAmount: a contract
-- that enables EOBI and names an amount overrides the client). CON-0007 is
-- Active, so eobi_amount is a locked term and moves through amend_contract(),
-- which writes the old and new figure to audit_log. The client's own amount is
-- the fallback and is set to match so the two never disagree.
--
-- Disbursed payslips keep the EOBI they were paid against; an undisbursed one
-- recomputes with 407 on its next save.

do $mig$
declare
  c_hmc uuid := 'bb468666-1dd3-4efe-84ca-6ca890c3a6f5';  -- HMC Taxila
  k_hmc uuid := '77cc83c9-8ec0-4bc5-9c0b-4a8032c1893f';  -- CON-0007
begin
  if (select client_id from public.contracts where id = k_hmc) is distinct from c_hmc then
    raise exception '0510: CON-0007 is not HMC Taxila''s contract. Nothing changed.';
  end if;

  if (select eobi_amount from public.contracts where id = k_hmc) is distinct from 407 then
    perform public.amend_contract(k_hmc, 'eobi_amount', '407',
      'EOBI deduction set to PKR 407 (migration 0510, asked 2026-10-08).');
  end if;

  update public.clients set eobi_amount = 407 where id = c_hmc and eobi_amount is distinct from 407;
end $mig$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0510 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
