-- 0513 — The revenue month is the service month. Two controls see what they
-- measure.
--
-- Three defects, one shape: a reader that looked at the wrong thing and so
-- reported a confident figure about something else. Found in the September
-- 2026 audit (Stage 1, 2026-10-16), measured on crm-design before writing.
--
-- 1. regional_pl_range BUCKETED INVOICES BY invoice_date.
--    Policy A4 recognises revenue in the service month. invoices.service_month
--    (a stored generated column, invoice_service_month(period_start,
--    period_end, invoice_date)) is the single definition, and the GL posts on
--    it. regional_pl_range alone read invoice_date, so September's invoices
--    raised on 1 October left September and landed in October:
--        ISB/RWP   9,924,388  instead of 14,083,412
--        Kashmir   2,817,003  instead of  4,295,303
--        Lahore    2,187,414  (unchanged — none of its invoices is late-dated)
--    23 invoices, 5,637,324. The same figure is partnership_allocation's
--    head-office driver, so the region-level HO split was wrong by the same
--    field (cash: ISB 371,593 / Kashmir 105,475 / Lahore 81,902 instead of
--    382,775 / 116,743 / 59,452).
--    The fix reads service_month, with p_start truncated to its month exactly
--    as pay_a already does for period_month in the same function.
--    NOT FIXED HERE, AND DEFERRED TO PART B: there are three head-office
--    drivers (partnership_allocation via this function; client_statement_loaded
--    on its own invoice CTE; ho_apportionment_driver on invoice_lines) and two
--    pools. After this migration the first two agree for September because the
--    date was their only difference there; they remain two implementations.
--    Part B must land them as one driver over one pool.
--
-- 2. payroll_attendance_drift COUNTED status = 'present' ONLY.
--    A double-duty day is stored as TWO attendance rows with status
--    'double_duty' (480 such days, never fewer or more than two rows, never
--    mixed with a 'present' row on the same date). Payroll counts the day once.
--    The check counted it zero times, so every double-duty guard drifted by
--    exactly half his double-duty row count: 152 of the check's 170 rows, HMC
--    140 of them. The 18 real rows — Nova, August, attendance 87 days above
--    what the payslips paid — were invisible inside that noise.
--    The fix counts DISTINCT dates with status in ('present','double_duty').
--
-- 3. cash_cockpit COUNTED THE BANK CONTROL ACCOUNT ONLY.
--    Balances sit on its children (1010.01–1010.04); 1010 itself carries
--    nothing, and since 0512 refuses postings to it, never will. The cash arm
--    already summed the control's children; the bank arm did not. So gross_cash
--    omitted every bank balance, and cash_forecast — which opens from
--    cash_cockpit.available_after_reserves — forecast from custodian cash
--    alone. Its green was as meaningless as its red.
--    The fix counts the bank control's children exactly as the cash arm counts
--    the cash control's. The view stays security_invoker.
--    NOTE, measured before applying: GGS's bank sub-accounts net NEGATIVE in
--    the GL today, because the 31 August opening batch (7,471,619.23 of bank
--    openings) is unposted. So this fix LOWERS the forecast's opening on GGS
--    until that batch posts. That is the forecast telling the truth about the
--    ledger it reads, not a defect in this change.
--
-- All three are surgery against the live definition, each anchor asserted to
-- appear exactly once, and each skipped on replay when its replacement is
-- already present. Every assertion below tests the failure itself, not the
-- fact that something moved.

-- 1. regional_pl_range ------------------------------------------------------
do $$
declare
  v_def  text := pg_get_functiondef('public.regional_pl_range(date,date,uuid)'::regprocedure);
  v_old  text := 'i.invoice_date between p_start and p_end';
  v_new  text := $r$i.service_month between date_trunc('month', p_start)::date and p_end /* 0513: revenue month is the service month (A4) */$r$;
  v_hits int;
begin
  if position(v_new in v_def) > 0 then
    raise notice '0513: regional_pl_range already reads service_month.';
  else
    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_hits <> 1 then
      raise exception '0513 REFUSED: regional_pl_range anchor appears % times, expected 1.', v_hits;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- 2. payroll_attendance_drift -----------------------------------------------
do $$
declare
  v_def  text := pg_get_functiondef('public.payroll_attendance_drift(uuid)'::regprocedure);
  v_a    text := 'select count(*) as n';
  v_a2   text := 'select count(distinct ar.attendance_date) as n /* 0513 */';
  v_b    text := $q$and ar.status = 'present'$q$;
  v_b2   text := $q$and ar.status in ('present', 'double_duty') /* 0513: a double-duty day is two rows, one day */$q$;
  v_hits int;
begin
  if position(v_b2 in v_def) > 0 then
    raise notice '0513: payroll_attendance_drift already counts double duty.';
  else
    v_hits := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
    if v_hits <> 1 then
      raise exception '0513 REFUSED: payroll_attendance_drift count anchor appears % times, expected 1.', v_hits;
    end if;
    v_hits := (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b);
    if v_hits <> 1 then
      raise exception '0513 REFUSED: payroll_attendance_drift status anchor appears % times, expected 1.', v_hits;
    end if;
    execute replace(replace(v_def, v_a, v_a2), v_b, v_b2);
  end if;
end $$;

-- 3. cash_cockpit -----------------------------------------------------------
do $$
declare
  v_def  text := pg_get_viewdef('public.cash_cockpit'::regclass);
  v_old  text := $q$WHEN (a.system_key = 'bank'::text) THEN (jl.debit - jl.credit)$q$;
  v_new  text := $q$WHEN ((a.system_key = 'bank'::text) OR (a.parent_id IN ( SELECT chart_of_accounts.id FROM chart_of_accounts WHERE (chart_of_accounts.system_key = 'bank'::text)))) THEN (jl.debit - jl.credit)$q$;
  v_hits int;
begin
  if v_def like '%(chart_of_accounts.system_key = ''bank''::text)))) THEN%' then
    raise notice '0513: cash_cockpit already counts the bank sub-accounts.';
  else
    v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_hits <> 1 then
      raise exception '0513 REFUSED: cash_cockpit bank anchor appears % times, expected 1.', v_hits;
    end if;
    execute 'create or replace view public.cash_cockpit with (security_invoker = true) as '
         || replace(v_def, v_old, v_new);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- ASSERTIONS. Each names the failure and can distinguish it.
-- ---------------------------------------------------------------------------
do $$
declare v_bad int; v_txt text;
begin
  -- 1a. No revenue month derived from invoice_date is left in the function.
  if position('invoice_date' in pg_get_functiondef('public.regional_pl_range(date,date,uuid)'::regprocedure)) > 0 then
    raise exception '0513 FAILED: regional_pl_range still reads invoice_date.';
  end if;

  -- 1b. For every company and each of the last four months, the regional P&L's
  -- accrual revenue equals invoiced revenue by SERVICE month. A function still
  -- bucketing by invoice_date fails this for any month with a late-dated
  -- invoice (September 2026 on GGS: 5,637,324).
  select count(*), string_agg(c.name || ' ' || to_char(m.m, 'YYYY-MM'), ', ')
    into v_bad, v_txt
    from public.companies c
   cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m
                 from generate_series(0, 3) k) m
   where (select coalesce(sum(r.revenue_accrual), 0)
            from public.regional_pl_range(m.m, (m.m + interval '1 month - 1 day')::date, c.id) r)
      <> (select coalesce(sum(i.invoice_amount), 0) from public.invoices i
           where i.company_id = c.id and i.service_month = m.m);
  if v_bad > 0 then
    raise exception '0513 FAILED: regional_pl_range revenue disagrees with service-month invoicing for: %', v_txt;
  end if;

  -- 2. No drift row is explained by double duty. Before this migration 152 rows
  -- had a gap of exactly half the employee's double-duty row count.
  select count(*) into v_bad
    from public.companies c
   cross join lateral public.payroll_attendance_drift(c.id) d
   where -d.day_delta * 2 = (select count(*) from public.attendance_records ar
                               where ar.employee_id = d.employee_id
                                 and ar.status = 'double_duty'
                                 and date_trunc('month', ar.attendance_date)::date = d.period_month)
     and d.day_delta <> 0;
  if v_bad > 0 then
    raise exception '0513 FAILED: % drift row(s) are still exactly half a double-duty count.', v_bad;
  end if;

  -- 3a. gross_cash equals the GL over the WHOLE cash and bank subtrees, walked
  -- to any depth. A cockpit that omits the bank children fails this whenever a
  -- bank account carries a balance.
  with recursive t as (
    select a.id, a.company_id from public.chart_of_accounts a where a.system_key in ('cash', 'bank')
    union all
    select c.id, c.company_id from public.chart_of_accounts c join t on c.parent_id = t.id
  ), gl as (
    select t.company_id, coalesce(sum(jl.debit - jl.credit), 0) bal
      from t left join public.journal_lines jl on jl.account_id = t.id group by 1
  )
  select count(*) into v_bad
    from public.cash_cockpit k join gl on gl.company_id = k.company_id
   where k.gross_cash <> gl.bal;
  if v_bad > 0 then
    raise exception '0513 FAILED: cash_cockpit.gross_cash disagrees with the cash+bank GL for % company(ies).', v_bad;
  end if;

  -- 3b. The view kept its security_invoker option.
  if not coalesce((select 'security_invoker=true' = any(reloptions) from pg_class
                    where oid = 'public.cash_cockpit'::regclass), false) then
    raise exception '0513 FAILED: cash_cockpit lost security_invoker.';
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0513 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
