-- 0645 — the finance report counts salaries by when they were RECORDED, and
-- gives payroll and receivables per region.
--
-- Shayan, 6 Nov 2026: "it shows payroll paid 0 even though we cleared Emaar
-- yesterday" and "i want region wise report, isb/rwp region mainly".
--
-- 1. The report covers what was ENTERED since the last report, but
--    'salaries_paid' tested payslips.disbursed_at — the PAYMENT DATE, stamped
--    at midday of the day chosen. Emaar's October salaries were entered on
--    5 Nov at 23:54 with payment date 5 Nov 12:00; the window opened 5 Nov
--    15:38 (24 h before the first export), so all 71 fell outside it and the
--    section said nothing was disbursed. Every payout writes a
--    'payslips_disbursement' journal entry at the moment it is recorded (113
--    since 1 Nov, every one matched to its payslip), so that is the clock now;
--    a payslip with no such entry falls back to its payment date.
--
-- 2. Region. v_branch scopes only a login PINNED to a region; the region bar
--    narrowed the lists in the browser, but payroll_status and receivables are
--    single totals, so "ISB/RWP" still showed the whole company's. The lists
--    carried branch_id already; now salaries_paid is grouped by month AND
--    branch, and payroll_status_by_branch / receivables_by_branch sit beside
--    the company totals, for the screen to pick from. The totals are unchanged.
--
-- finance_report has several authors (0632, 0633 and earlier), so this is
-- surgery against the live definition, each anchor asserted to appear once.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.finance_report'::regproc);
  procedure_once text;
  n int;
  a1 constant text := $a$jsonb_build_object('month', s.period_month, 'people', s.n, 'paid', s.paid)$a$;
  a2 constant text := $a$(select ps.period_month, count(*) n, sum(coalesce(ps.amount_paid, ps.net_salary)) paid from public.payslips ps$a$;
  a3 constant text := $a$where ps.company_id = v_co and ps.disbursed and ps.disbursed_at >= p_from and ps.disbursed_at < p_to and (v_branch is null or ps.branch_id = v_branch)$a$;
  a4 constant text := $a$group by ps.period_month) s)$a$;
  a5 constant text := $a$from public.payslips ps where ps.company_id = v_co and ps.period_month = v_pay and (v_branch is null or ps.branch_id = v_branch)),$a$;
  a6 constant text := $a$from public.client_receivables_base() t where v_branch is null or t.branch_id = v_branch),$a$;
begin
  foreach procedure_once in array array[a1, a2, a3, a4, a5, a6] loop
    n := (length(v_def) - length(replace(v_def, procedure_once, ''))) / length(procedure_once);
    if n <> 1 then raise exception '0645 REFUSED: an anchor in finance_report appears % times, expected once: %', n, left(procedure_once, 60); end if;
  end loop;
  if position('payroll_status_by_branch' in v_def) > 0 then
    raise exception '0645 REFUSED: finance_report already has payroll_status_by_branch — something changed it since this was written.';
  end if;

  v_def := replace(v_def, a1, $r$jsonb_build_object('month', s.period_month, 'branch_id', s.branch_id, 'people', s.n, 'paid', s.paid)$r$);
  v_def := replace(v_def, a2, $r$(select ps.period_month, ps.branch_id, count(*) n, sum(coalesce(ps.amount_paid, ps.net_salary)) paid from public.payslips ps$r$);
  v_def := replace(v_def, a3, $r$where ps.company_id = v_co and ps.disbursed
               -- 0645: when the payout was RECORDED (its journal entry), not the payment date chosen.
               and (exists (select 1 from public.journal_entries je where je.source_table = 'payslips_disbursement' and je.source_id = ps.id
                             and je.created_at >= p_from and je.created_at < p_to)
                    or (not exists (select 1 from public.journal_entries je where je.source_table = 'payslips_disbursement' and je.source_id = ps.id)
                        and ps.disbursed_at >= p_from and ps.disbursed_at < p_to))
               and (v_branch is null or ps.branch_id = v_branch)$r$);
  v_def := replace(v_def, a4, $r$group by ps.period_month, ps.branch_id) s)$r$);
  v_def := replace(v_def, a5, a5 || $r$
    -- 0645: the same, per region, for the region bar.
    'payroll_status_by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch_id', b.branch_id, 'month', v_pay, 'people', b.n, 'net', b.net,
                                                 'paid', b.paid, 'unpaid_people', b.unpaid, 'remaining', b.rem))
      from (select ps.branch_id, count(*) n, sum(ps.net_salary) net, sum(coalesce(ps.amount_paid, 0)) paid,
                   count(*) filter (where not coalesce(ps.disbursed, false)) unpaid, sum(greatest(ps.net_salary - coalesce(ps.amount_paid, 0), 0)) rem
              from public.payslips ps where ps.company_id = v_co and ps.period_month = v_pay and (v_branch is null or ps.branch_id = v_branch)
             group by ps.branch_id) b), '[]'::jsonb),$r$);
  v_def := replace(v_def, a6, a6 || $r$
    -- 0645: the same, per region.
    'receivables_by_branch', coalesce((select jsonb_agg(jsonb_build_object('branch_id', x.branch_id, 'owed', x.owed, 'overdue', x.overdue, 'over_90', x.o90,
                                              'clients_owing', x.co, 'wht_awaiting', x.wht))
      from (select t.branch_id, sum(t.balance) owed, sum(t.overdue) overdue, sum(t.age_over_90) o90,
                   count(*) filter (where t.balance > 0.5) co, sum(t.wht_awaiting_certificate) wht
              from public.client_receivables_base() t where v_branch is null or t.branch_id = v_branch group by t.branch_id) x), '[]'::jsonb),$r$);
  execute v_def;
end
$surgery$;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_isb  constant uuid := '87c67763-e53c-4e0c-8362-38cd8abe4bb2';
  r jsonb; v_msg text; v_ran int := 0; v_paid numeric; v_tot numeric; v_sum numeric;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    -- The window the first report used: 5 Nov 15:38 PKT to 6 Nov 15:38 PKT.
    r := public.finance_report('2026-11-05 10:38:00+00', '2026-11-06 10:38:00+00');

    -- 1. October's ISB/RWP payouts recorded on 5 Nov evening are now inside that window.
    select coalesce(sum((x->>'paid')::numeric), 0) into v_paid from jsonb_array_elements(r->'salaries_paid') x
     where x->>'month' = '2026-10-01' and x->>'branch_id' = v_isb::text;
    if v_paid < 3000000 then raise exception '0645 REFUSED: ISB/RWP October salaries recorded on 5 Nov still read % in the window.', v_paid; end if;
    v_ran := v_ran + 1;

    -- 2. The per-region payroll position adds up to the company total it sits beside.
    select coalesce(sum((x->>'net')::numeric), 0) into v_sum from jsonb_array_elements(r->'payroll_status_by_branch') x;
    v_tot := coalesce((r->'payroll_status'->>'net')::numeric, 0);
    if abs(v_sum - v_tot) > 0.5 then raise exception '0645 REFUSED: payroll by region sums to %, the total says %.', v_sum, v_tot; end if;
    v_ran := v_ran + 1;

    -- 3. So do receivables.
    select coalesce(sum((x->>'owed')::numeric), 0) into v_sum from jsonb_array_elements(r->'receivables_by_branch') x;
    v_tot := coalesce((r->'receivables'->>'owed')::numeric, 0);
    if abs(v_sum - v_tot) > 0.5 then raise exception '0645 REFUSED: receivables by region sum to %, the total says %.', v_sum, v_tot; end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 3 then raise exception '0645 REFUSED: % of 3 assertions ran.', v_ran; end if;
    raise exception '0645-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0645-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0645 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0645 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
