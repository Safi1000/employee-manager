-- 0229 — Close two blind spots left by 0227/0228.
--
-- (a) applied_migration_names() returns names only, so a repo file EDITED IN
--     PLACE after being applied is undetectable — and 34 pre-0109 names are now
--     baselined in scripts/migration-baseline.txt, which would make that blind
--     spot permanent rather than bounded. Returning an md5 alongside the name
--     closes it without exposing SQL through a service-role surface.
--
-- (b) attendance_gate_mode_residue() (0228) is not called by anything. A
--     function nobody calls is a comment. 0228 argued it should stay out of
--     ledger_checks because it is an operational data-quality issue rather than
--     an accounting identity; that was the wrong call. ledger_checks is the
--     harness that actually gets run after every change, and an unread function
--     is worth less than a slightly impure one.
--
-- Both failing checks below are MEANT to be red:
--   no_billing_clients_on_head_office  — 1, until Ironclad is assigned a region
--   no_gate_mode_in_attendance_status  — 24, until the join-date question is
--                                        answered and the rows reclassified

create or replace function public.applied_migration_digests()
returns table(name text, digest text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select m.name, md5(array_to_string(m.statements, E'\n'))
    from supabase_migrations.schema_migrations m
   order by m.version;
$function$;

revoke all on function public.applied_migration_digests() from public, anon, authenticated;
grant execute on function public.applied_migration_digests() to service_role;

comment on function public.applied_migration_digests() is
  'Applied migration names with an md5 of their SQL, for scripts/check-migrations.mjs content drift detection. Service role only; returns a digest, never the SQL.';

create or replace function public.ledger_checks(p_company_id uuid)
returns table(check_name text, expected numeric, actual numeric,
              difference numeric, passed boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with tb as (
    select coalesce(sum(jl.debit), 0) dr, coalesce(sum(jl.credit), 0) cr
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.company_id = p_company_id
  ),
  onesided as (
    select count(*)::numeric n
      from public.journal_entries je
      join lateral (
        select coalesce(sum(debit), 0) dr, coalesce(sum(credit), 0) cr
          from public.journal_lines where journal_entry_id = je.id
      ) x on true
     where je.company_id = p_company_id and x.dr <> x.cr
  ),
  bal as (
    select a.system_key, coalesce(sum(jl.debit - jl.credit), 0) net
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
     group by a.system_key
  ),
  ar_sub as (
    select coalesce((select sum(i.invoice_amount) from public.invoices i
                      where i.company_id = p_company_id
                        and coalesce(i.status, '') <> 'Written-Off'), 0)
         - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  adv_sub as (
    select coalesce((select sum(a.amount) from public.advances a
                      where a.company_id = p_company_id), 0)
         - coalesce((select sum(ps.advance) from public.payslips ps
                      where ps.company_id = p_company_id), 0) bal
  ),
  wht_sub as (
    select coalesce((select sum(coalesce(p.withholding_amount, 0))
                       from public.invoice_payments p
                      where p.company_id = p_company_id), 0) bal
  ),
  payroll_owed as (
    select coalesce(sum(ps.net_salary) filter (where not ps.disbursed), 0) owed
      from public.payslips ps where ps.company_id = p_company_id
  ),
  ho_clients as (
    select count(distinct i.client_id)::numeric n
      from public.invoices i
      join public.branches b on b.id = i.branch_id
     where i.company_id = p_company_id and b.is_head_office
  ),
  gate_residue as (
    select count(*)::numeric n from public.attendance_records a
     where a.company_id = p_company_id and a.status = 'blocked'
  )
  select 'trial_balance_debits_equal_credits'::text, tb.dr, tb.cr, tb.dr - tb.cr, tb.dr = tb.cr from tb
  union all
  select 'no_one_sided_entries', 0, onesided.n, onesided.n, onesided.n = 0 from onesided
  union all
  select 'ar_control_equals_open_invoices', ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0),
         coalesce((select net from bal where system_key = 'ar'), 0) - ar_sub.bal,
         coalesce((select net from bal where system_key = 'ar'), 0) = ar_sub.bal
    from ar_sub
  union all
  select 'employee_advances_control_not_in_client_ar', adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0),
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) - adv_sub.bal,
         coalesce((select net from bal where system_key = 'employee_advances_receivable'), 0) = adv_sub.bal
    from adv_sub
  union all
  select 'wht_receivable_equals_deductions_less_cprs', wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0),
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) - wht_sub.bal,
         coalesce((select net from bal where system_key = 'wht_receivable'), 0) = wht_sub.bal
    from wht_sub
  union all
  select 'salaries_payable_equals_undisbursed_net_pay', payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0),
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) - payroll_owed.owed,
         coalesce((select -net from bal where system_key = 'salaries_payable'), 0) = payroll_owed.owed
    from payroll_owed
  union all
  select 'no_billing_clients_on_head_office', 0, ho_clients.n, ho_clients.n, ho_clients.n = 0
    from ho_clients
  union all
  select 'no_gate_mode_in_attendance_status', 0, gate_residue.n, gate_residue.n, gate_residue.n = 0
    from gate_residue;
$function$;
