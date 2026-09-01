-- 0313 — total_due is a presentation field. Nothing may read it as a balance.
--
-- WHAT total_due IS
--
-- It is what a printed invoice shows the client: this month's charge PLUS what
-- they still owe, so the client sees one number to pay against. It is written
-- in exactly one place — the invoice generator — and read legitimately in
-- exactly one context, the invoice document (invoicePdf.ts, invoiceTemplates.ts).
--
-- WHY IT CANNOT BE A RECEIVABLE
--
-- Summing it across invoices double-counts the arrears. June is counted on its
-- own row and again inside July's total_due. That is arithmetic, not policy.
--
-- Measured on crm-design (PRODUCTION), 2026-09-02:
--
--   outstanding on invoice_amount ....... 4,118,877.00
--   outstanding on total_due ............ 6,042,877.00
--   divergence .......................... 1,924,000.00
--
-- and the divergence decomposes exactly. Three July invoices carry
-- total_due = 2 x invoice_amount with ZERO invoice_taxes, and each has an
-- unpaid June counterpart for the identical amount:
--
--   STS-26-CTD-07  1,050,000 -> 2,100,000   (CTD-06 unpaid, 1,050,000)
--   STS-26-DPA-07    784,000 -> 1,568,000   (DPA-06 unpaid,   784,000)
--   STS-26-IRN-07     90,000 ->   180,000   (IRN-06 unpaid,    90,000)
--                                            -------------------------
--                                            1,924,000
--
-- The mechanism is proved by the arithmetic, not inferred from the shape.
--
-- THIS IS THE THIRD TIME THIS COLUMN HAS PRODUCED A DEFECT, and the first
-- analysis of this project's reports named it: regional_receivables_aging
-- computes outstanding as total_due - amount_received, but total_due is
-- cumulative, so every prior month is counted again. Still live, now measured.
--
-- WHAT CHANGES
--
-- Six database objects moved from coalesce(total_due, invoice_amount) to
-- invoice_amount. ar_control_equals_open_invoices already used invoice_amount
-- and was right; it is untouched.
--
-- write_off_receivable is the urgent one and is first below. Writing off
-- STS-26-CTD-07 today would post bad debt of 2,100,000 against a receivable
-- the GL recognises as 1,050,000 — a 1,050,000 over-write-off that would then
-- turn ar_control_equals_open_invoices red.
--
-- AGING, BEFORE AND AFTER, per region (crm-design, 2026-09-02). The team
-- collects against these numbers. This is a correction, not a regression, and
-- no invoice leaves the open set:
--
--   North Region   3,496,877.00 -> 2,356,877.00   (-1,140,000.00)
--   South Region   2,546,000.00 -> 1,762,000.00   (-  784,000.00)
--                                                  --------------
--                                                   -1,924,000.00
--
-- THE COLUMN STAYS. Same disposition as withholding_tax: a legitimate
-- invoice-document field. Keep it, keep printing it, stop treating it as a
-- balance.

-- ---------------------------------------------------------------------------
-- 1. write_off_receivable — FIRST, because it posts.
-- ---------------------------------------------------------------------------

create or replace function public.write_off_receivable(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  inv record; v_bearer text; v_region uuid; v_out numeric(16,2); v_bad uuid; v_ar uuid;
begin
  -- tenant guard [resolved]: owning company looked up from p_invoice_id via public.invoices (0242)
  if p_invoice_id is not null then perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id)); end if;

  if coalesce(trim(p_reason),'') = '' then
    raise exception 'a write-off reason is required' using errcode='23514';
  end if;
  select * into inv from public.invoices where id = p_invoice_id;
  if not found then raise exception 'invoice % not found', p_invoice_id using errcode='23503'; end if;

  -- 0313. Was coalesce(inv.total_due, inv.invoice_amount, 0). total_due carries
  -- the client's arrears as well, so writing off against it wrote off other
  -- invoices' balances too — and left the AR control short by the difference.
  v_out := coalesce(inv.invoice_amount, 0) - coalesce(inv.amount_received, 0);
  if v_out <= 0 then
    raise exception 'invoice has nothing outstanding to write off' using errcode='23514';
  end if;
  select bad_debt_bearer into v_bearer from public.finance_settings where company_id = inv.company_id;
  if coalesce(v_bearer,'region') = 'head_office' then
    v_region := public.head_office_region(inv.company_id);
  else
    v_region := public.receivable_owner_region(inv.client_id);
  end if;

  v_bad := public.ensure_bad_debt_account(inv.company_id);

  select id into v_ar  from public.chart_of_accounts
    where company_id = inv.company_id and system_key = 'ar' limit 1;
  if v_ar is null then
    raise exception 'company % has no receivables (ar) account', inv.company_id using errcode='23503';
  end if;

  perform public.post_journal(
    inv.company_id, current_date,
    'Bad debt write-off: '||coalesce(inv.invoice_number,'')||' — '||p_reason,
    'invoices', inv.id, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_bad, 'debit',  v_out, 'credit', 0),
      jsonb_build_object('account_id', v_ar,  'debit', 0,       'credit', v_out)
    ),
    v_region);
  update public.invoices
     set status = 'Written-Off',
         notes  = coalesce(notes,'')||' [written off '||current_date||': '||p_reason||']',
         updated_at = now()
   where id = p_invoice_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. cash_forecast — expected inflow was the arrears-inclusive figure.
-- ---------------------------------------------------------------------------

create or replace function public.cash_forecast(p_company_id uuid, p_weeks integer default 13)
returns table(week_no integer, week_start date, opening_balance numeric,
              expected_inflow numeric, expected_outflow numeric,
              closing_balance numeric, is_breach boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_open      numeric;
  v_min       numeric := public.minimum_cash(p_company_id);
  v_weekly_payroll  numeric;
  v_weekly_overhead numeric;
  i           integer;
  v_ws        date;
  v_we        date;
  v_in        numeric;
  v_out       numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select available_after_reserves into v_open from public.cash_cockpit where company_id = p_company_id;
  v_open := coalesce(v_open, 0);
  v_weekly_payroll  := round(public.avg_monthly_net_payroll(p_company_id) / 4.33, 2);
  v_weekly_overhead := round(public.avg_monthly_overhead(p_company_id) / 4.33, 2);

  for i in 1 .. greatest(p_weeks, 1) loop
    v_ws := (date_trunc('week', current_date) + ((i - 1) || ' weeks')::interval)::date;
    v_we := v_ws + 6;

    -- 0313: invoice_amount, not coalesce(total_due, invoice_amount). Forecasting
    -- inflow from the cumulative figure counted each client's arrears once per
    -- outstanding invoice, so the forecast over-collected.
    select coalesce(sum(inv.invoice_amount - inv.amount_received), 0)
      into v_in
      from public.invoices inv
     where inv.company_id = p_company_id
       and inv.amount_received < inv.invoice_amount
       and greatest(inv.invoice_date + 30, current_date) between v_ws and v_we;

    select coalesce(sum(sf.amount), 0) into v_out
      from public.statutory_filings sf
     where sf.company_id = p_company_id and sf.paid_date is null
       and sf.due_date between v_ws and v_we;
    v_out := v_out + v_weekly_payroll + v_weekly_overhead
           + coalesce((select sum(ch.amount) from public.cheques ch
                        where ch.company_id = p_company_id and ch.status <> 'cleared'
                          and ch.cheque_date between v_ws and v_we), 0);

    week_no := i;
    week_start := v_ws;
    opening_balance := v_open;
    expected_inflow := v_in;
    expected_outflow := v_out;
    closing_balance := v_open + v_in - v_out;
    is_breach := (v_open + v_in - v_out) < v_min;

    v_open := closing_balance;
    return next;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The four views.
-- ---------------------------------------------------------------------------

create or replace view public.regional_receivables_aging as
 WITH open_inv AS (
         SELECT i.company_id,
            receivable_owner_region(i.client_id) AS owner_region,
            c.workout_account,
            COALESCE(i.invoice_amount, 0::numeric) - COALESCE(i.amount_received, 0::numeric) AS outstanding,
            CURRENT_DATE - i.invoice_date AS age_days
           FROM invoices i
             JOIN clients c ON c.id = i.client_id
          WHERE COALESCE(i.status, ''::text) <> 'Written-Off'::text AND (COALESCE(i.invoice_amount, 0::numeric) - COALESCE(i.amount_received, 0::numeric)) > 0::numeric
        )
 SELECT o.company_id,
    o.owner_region AS branch_id,
    b.name AS region_name,
    o.workout_account,
    sum(o.outstanding) AS total_outstanding,
    sum(o.outstanding) FILTER (WHERE o.age_days <= 30) AS bucket_current,
    sum(o.outstanding) FILTER (WHERE o.age_days >= 31 AND o.age_days <= 60) AS bucket_31_60,
    sum(o.outstanding) FILTER (WHERE o.age_days >= 61 AND o.age_days <= 90) AS bucket_61_90,
    sum(o.outstanding) FILTER (WHERE o.age_days > 90) AS bucket_90_plus,
    round(COALESCE(sum(o.outstanding * o.age_days::numeric) / NULLIF(sum(o.outstanding), 0::numeric), 0::numeric), 1) AS dso_weighted_days
   FROM open_inv o
     JOIN branches b ON b.id = o.owner_region
  GROUP BY o.company_id, o.owner_region, b.name, o.workout_account;

create or replace view public.due_invoice_reminders as
 WITH cad AS (
         SELECT i.id AS invoice_id,
            i.company_id,
            i.client_id,
            i.invoice_number,
            i.invoice_date,
            cl.name AS client_name,
            cl.workout_account,
            COALESCE(i.invoice_amount, 0::numeric) - COALESCE(i.amount_received, 0::numeric) AS outstanding,
            CURRENT_DATE - i.invoice_date AS age_days,
            unnest(COALESCE(fs.reminder_cadence_days, '{0,7,15,30,45}'::integer[])) AS step_day
           FROM invoices i
             JOIN clients cl ON cl.id = i.client_id
             LEFT JOIN finance_settings fs ON fs.company_id = i.company_id
          WHERE (COALESCE(i.status, ''::text) <> ALL (ARRAY['Paid'::text, 'Written-Off'::text])) AND (COALESCE(i.invoice_amount, 0::numeric) - COALESCE(i.amount_received, 0::numeric)) > 0::numeric
        )
 SELECT DISTINCT ON (invoice_id) invoice_id,
    company_id,
    client_id,
    client_name,
    invoice_number,
    invoice_date,
    outstanding,
    workout_account,
    age_days,
    step_day AS due_step
   FROM cad c
  WHERE age_days >= step_day AND NOT (EXISTS ( SELECT 1
           FROM invoice_reminders r
          WHERE r.invoice_id = c.invoice_id AND r.step_day = c.step_day))
  ORDER BY invoice_id, step_day DESC;

create or replace view public.regional_scorecard as
 SELECT company_id,
    id AS branch_id,
    name AS region_name,
    kind AS region_kind,
    ( SELECT count(*) AS count
           FROM employees e
          WHERE e.branch_id = b.id AND e.lifecycle_state = 'active'::employee_lifecycle_state) AS active_headcount,
    ( SELECT count(*) AS count
           FROM incidents i
          WHERE i.branch_id = b.id AND EXTRACT(year FROM i.occurred_at) = EXTRACT(year FROM CURRENT_DATE)) AS incidents_ytd,
    ( SELECT count(*) AS count
           FROM no_show_events n
          WHERE n.branch_id = b.id AND n.event_date >= (CURRENT_DATE - 30)) AS no_shows_30d,
    ( SELECT COALESCE(sum(i.invoice_amount - i.amount_received), 0::numeric) AS "coalesce"
           FROM invoices i
          WHERE i.branch_id = b.id AND i.amount_received < i.invoice_amount) AS receivables_outstanding,
    region_operating_profit(company_id, id, EXTRACT(year FROM CURRENT_DATE)::integer) AS profit_ytd,
    region_operating_profit(company_id, id, EXTRACT(year FROM CURRENT_DATE)::integer - 1) AS profit_prior_year,
    interregion_net_position(company_id, id) AS inter_region_balance
   FROM branches b
  WHERE active;

create or replace view public.warning_alerts as
 SELECT e.company_id,
    e.branch_id,
    'verification_pending_rostered'::text AS category,
    'Verification-pending guard rostered: '::text || e.full_name AS message,
    'roster_assignments'::text AS ref_table,
    ra.id AS ref_id
   FROM roster_assignments ra
     JOIN employees e ON e.id = ra.employee_id
  WHERE (e.police_verification_status <> 'cleared'::vetting_status OR e.nadra_verisys_status <> 'cleared'::vetting_status) AND ra.assignment_date >= CURRENT_DATE
UNION ALL
 SELECT i.company_id,
    i.branch_id,
    'invoice_aging'::text AS category,
    ((('Invoice '::text || COALESCE(i.invoice_number, ''::text)) || ' is '::text) || (CURRENT_DATE - i.invoice_date)) || ' days old'::text AS message,
    'invoices'::text AS ref_table,
    i.id AS ref_id
   FROM invoices i
  WHERE i.amount_received < i.invoice_amount AND ((CURRENT_DATE - i.invoice_date) = ANY (ARRAY[30, 31, 45, 46]))
UNION ALL
 SELECT e.company_id,
    e.branch_id,
    'licence_expiring'::text AS category,
    'Weapon licence expiring for '::text || e.full_name AS message,
    'employees'::text AS ref_table,
    e.id AS ref_id
   FROM employees e
  WHERE e.weapon_licence_expiry IS NOT NULL AND e.weapon_licence_expiry >= CURRENT_DATE AND e.weapon_licence_expiry <= (CURRENT_DATE + 30) AND e.lifecycle_state = 'active'::employee_lifecycle_state
UNION ALL
 SELECT ch.company_id,
    ch.branch_id,
    'cheque_pending'::text AS category,
    ((('Cheque '::text || COALESCE(ch.cheque_number, ''::text)) || ' pending '::text) || (CURRENT_DATE - ch.cheque_date)) || ' days'::text AS message,
    'cheques'::text AS ref_table,
    ch.id AS ref_id
   FROM cheques ch
  WHERE ch.status <> 'cleared'::text AND (CURRENT_DATE - ch.cheque_date) > 15;

-- ---------------------------------------------------------------------------
-- 4. The check. No database object may read total_due.
--
--    There is no allowlist and none is needed: the invoice DOCUMENT is rendered
--    in the frontend (invoicePdf.ts, invoiceTemplates.ts) and the column is
--    written by the invoice generator. After the changes above, no function and
--    no view in the database has any business reading it. Zero is the whole
--    rule, which makes it a check with no exceptions to erode.
-- ---------------------------------------------------------------------------

create or replace function public.total_due_read_as_a_balance()
returns table(kind text, object_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- COMMENTS ARE STRIPPED FIRST. pg_get_functiondef returns the body including
  -- its comments, and the two functions corrected above EXPLAIN the defect in
  -- prose that names the column. Without this the check goes red on its own
  -- explanation — the same trap scripts/check-outstanding.mjs has to avoid, and
  -- a checker that trips over its own documentation is a checker someone
  -- disables. A read is code, not a comment.
  select 'function'::text, p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and regexp_replace(pg_get_functiondef(p.oid), '--.*$', '', 'gn') ~* '\mtotal_due\M'
  union all
  select 'view'::text, c.relname::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('v', 'm')
     and regexp_replace(pg_get_viewdef(c.oid), '--.*$', '', 'gn') ~* '\mtotal_due\M'
  order by 1, 2;
$function$;

comment on function public.total_due_read_as_a_balance() is
  'Database objects that read invoices.total_due. Must be empty: total_due is the invoice DOCUMENT total (this month plus the client''s arrears) and summing it across invoices double-counts those arrears. Third defect from this column; see 0313.';

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with real_checks as (
    select b.check_name, b.expected, b.actual, b.difference, b.passed
      from public.ledger_checks_base(p_company_id) b
     where b.check_name <> 'checks_evaluated'
    union all
    select 'cash_per_location_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.custodian_held_operational(p_company_id) h
     where abs(h.difference) > 0.005
    union all
    select 'every_source_row_posted'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.unposted_source_rows(p_company_id)
    union all
    select 'bank_per_account_gl_equals_operational'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.bank_held_operational(p_company_id) b
     where abs(b.difference) > 0.005
    union all
    select 'no_negative_custodian_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.negative_custodian_balances(p_company_id)
    union all
    select 'profit_allocation_exhausts_pool'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.profit_allocation_over_allocated(p_company_id)
    union all
    select 'payroll_accrual_matches_attendance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.payroll_attendance_drift(p_company_id)
    union all
    -- Company-independent by nature: it reads the catalogue, not the data. It
    -- lives here anyway because this is the surface anyone actually calls, and
    -- a detector nothing calls is the defect 0288 exists to find.
    select 'total_due_not_read_as_a_balance'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.total_due_read_as_a_balance()
  )
  select * from real_checks
  union all
  -- 19 = the number of REAL checks. The function returns one more row than
  -- this — the canary itself. Bump the constant deliberately when adding a
  -- check; never to make this row green.
  select 'checks_evaluated'::text,
         19::numeric,
         (select count(*) from real_checks)::numeric,
         (select count(*) from real_checks)::numeric - 19,
         (select count(*) from real_checks) = 19;
$function$;

-- ---------------------------------------------------------------------------
-- 5. PROOF, BOTH DIRECTIONS.
--
--    Green now is not evidence: the check would read zero if it were spelled
--    wrong, if the regex never matched, or if it scanned the wrong catalogue.
--    So a view that reads total_due is created, the check must go red, and the
--    subtransaction is rolled back by a deliberate raise.
-- ---------------------------------------------------------------------------

do $$
declare
  v_before int;
  v_red    int;
  v_after  int;
begin
  select count(*) into v_before from public.total_due_read_as_a_balance();
  if v_before <> 0 then
    raise exception
      '0313: % database object(s) still read total_due after this migration: %',
      v_before,
      (select string_agg(kind || ' ' || object_name, ', ')
         from public.total_due_read_as_a_balance());
  end if;

  begin
    execute 'create view public._probe_0313_total_due as
             select id, coalesce(total_due, invoice_amount) - amount_received as outstanding
               from public.invoices';
    select count(*) into v_red from public.total_due_read_as_a_balance();
    raise exception 'ROLLBACK_PROOF';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROOF' then
        raise exception '0313: the synthetic probe failed for the wrong reason: % %', sqlstate, sqlerrm;
      end if;
  end;

  if coalesce(v_red, 0) < 1 then
    raise exception '0313: THE CHECK CANNOT FAIL — a view reading total_due was not detected';
  end if;

  select count(*) into v_after from public.total_due_read_as_a_balance();
  if v_after <> 0 then
    raise exception '0313: the probe view did not unwind — % object(s) still match', v_after;
  end if;

  raise notice '0313: total_due_not_read_as_a_balance proved — red on a probe view (%), green after rollback', v_red;
end $$;

do $$
declare v_n int; v_ok boolean; v_co uuid;
begin
  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_n from public.ledger_checks(v_co);
  if v_n <> 20 then
    raise exception '0313: ledger_checks returns % rows, 20 expected (19 checks + canary)', v_n;
  end if;
  select passed into v_ok from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if not coalesce(v_ok, false) then
    raise exception '0313: checks_evaluated is red after the bump';
  end if;
end $$;
