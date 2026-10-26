-- 0556 — Waheed Shahzad Plastic Works' contract starts 1 July 2026
--
-- DECIDED 2026-10-26 (Shayan): "date of contract is wrong date is 1st july".
--
-- CON-0043 (Waheed Shahzad Plastic Works, Lahore, 4 day guards at 61,450) was
-- entered on 9 October with that day as its start. Its September invoice
-- GGS-26-WSP-09 (245,800) therefore had no September billing period to take,
-- and 0555 left it without one.
--
-- The start date is a locked term of an active contract, so it is corrected
-- through amend_contract — the logged correction path, which records old and
-- new value and the reason in the audit log. The invoice then takes its
-- contract's September billing period (dates only; its amount, service month
-- and revenue do not move).

do $mig$
declare
  v_k  constant uuid := 'fce27b3c-f633-4fc7-99bc-1ab1a02ba511';  -- CON-0043
  v_inv uuid; v_s date; v_e date; v_n int; v_rev_before numeric; v_rev_after numeric;
begin
  if (select contract_code from public.contracts where id = v_k) is distinct from 'CON-0043' then
    raise exception '0556 REFUSED: the contract is not CON-0043.';
  end if;

  if (select start_date from public.contracts where id = v_k) <> '2026-07-01' then
    perform public.amend_contract(v_k, 'start_date', '2026-07-01',
      'Entered 9 Oct 2026 with the entry date as its start; the contract began 1 July 2026 (Shayan, 26 Oct 2026). 0556.');
  end if;
  if (select start_date from public.contracts where id = v_k) <> '2026-07-01' then
    raise exception '0556 REFUSED: CON-0043 does not start 1 July after the amendment.';
  end if;

  select id into v_inv from public.invoices where invoice_number = 'GGS-26-WSP-09' and contract_id = v_k;
  if v_inv is not null and (select period_start from public.invoices where id = v_inv) is null then
    select count(*), min(p.period_start), min(p.period_end) into v_n, v_s, v_e
      from public.contract_periods(v_k, 'billing', '2026-11-01') p where p.service_month = '2026-09-01';
    if v_n <> 1 then raise exception '0556 REFUSED: CON-0043 has % billing periods in September 2026.', v_n; end if;

    select coalesce(sum(jl.credit - jl.debit), 0) into v_rev_before
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = v_inv and a.account_type = 'revenue';
    update public.invoices set period_start = v_s, period_end = v_e where id = v_inv;
    select coalesce(sum(jl.credit - jl.debit), 0) into v_rev_after
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.source_table = 'invoices' and je.source_id = v_inv and a.account_type = 'revenue';
    if v_rev_after <> v_rev_before then
      raise exception '0556 REFUSED: GGS-26-WSP-09 moved revenue from % to %.', v_rev_before, v_rev_after;
    end if;
  end if;

  if exists (select 1 from public.invoices where invoice_number = 'GGS-26-WSP-09' and period_start is distinct from '2026-09-01') then
    raise exception '0556 REFUSED: GGS-26-WSP-09 does not cover September.';
  end if;
  raise notice '0556: CON-0043 starts 1 July 2026; GGS-26-WSP-09 covers 1–30 September.';
end $mig$;
