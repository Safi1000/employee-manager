-- 0223 — Payroll cost is attributed to the client the guard actually worked for.
--
-- 0222 posted the payroll expense against `employees.client_id`, a CURRENT
-- pointer maintained by sync_employee_active_client. A guard who transfers
-- mid-month, or covers a shift as a reliever, silently moves the whole month's
-- cost to the wrong client — and therefore moves client profitability, the
-- regional partner's share on that client, and the equity residual.
--
-- `payroll_cost_by_client()` already resolves this correctly from
-- attendance_records.worked_for_client_id. This migration extracts that
-- convention into a per-payslip splitter and posts through it, so the ledger
-- and that report cannot disagree.
--
-- Measured before the fix (sandbox): 0 payslips span >1 client and 0 guard-days
-- were misattributed, so this corrects no existing figure. It closes a latent
-- defect that bites the first time a guard moves.

-- ---------------------------------------------------------------------------
-- Per-payslip client weighting, matching payroll_cost_by_client() exactly:
-- present / double_duty / relief_cover days, keyed on the client actually
-- worked for, falling back to the employee's client when there is no
-- attendance in the month.
-- ---------------------------------------------------------------------------

create or replace function public.payslip_client_split(p_id uuid)
returns table(client_id uuid, weight numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with ps as (
    select p.employee_id, p.period_month, e.client_id as fallback
      from public.payslips p
      join public.employees e on e.id = p.employee_id
     where p.id = p_id
  ),
  days as (
    select coalesce(a.worked_for_client_id, ps.fallback) as cid, count(*)::numeric as d
      from ps
      join public.attendance_records a on a.employee_id = ps.employee_id
       and a.attendance_date >= ps.period_month
       and a.attendance_date <  (ps.period_month + interval '1 month')
       and lower(a.status) in ('present', 'double_duty', 'relief_cover')
     group by 1
  ),
  tot as (select coalesce(sum(d), 0) as t from days)
  select days.cid, days.d / tot.t
    from days cross join tot where tot.t > 0
  union all
  select ps.fallback, 1::numeric
    from ps cross join tot where tot.t = 0;
$function$;

comment on function public.payslip_client_split(uuid) is
  'Attendance-weighted client attribution for one payslip. Same convention as payroll_cost_by_client(); weights sum to 1.';

-- ---------------------------------------------------------------------------
-- Accrual now splits the payroll expense (and the employer statutory share)
-- across the clients actually worked for. Deduction legs stay employee-level:
-- an advance, an EOBI deduction or salary tax belongs to the person, not to a
-- client.
-- ---------------------------------------------------------------------------

create or replace function public.post_payslip_accrual(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  ps        record;
  v_cat     text;
  v_key     text;
  v_lines   jsonb := '[]'::jsonb;
  v_emp     jsonb;
  sp        record;
  v_rows    int;
  v_i       int := 0;
  v_alloc   numeric;
  v_running numeric := 0;
begin
  select * into ps from public.payslips where id = p_id;
  if not found then return; end if;

  select e.category into v_cat from public.employees e where e.id = ps.employee_id;
  v_key := case when v_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_emp := jsonb_build_object('employee_id', ps.employee_id);

  select count(*) into v_rows from public.payslip_client_split(p_id);

  -- Gross payroll expense, split by where the guard actually worked. The last
  -- slice takes the residual so the split sums to final_salary exactly.
  if coalesce(ps.final_salary, 0) <> 0 and v_rows > 0 then
    for sp in select * from public.payslip_client_split(p_id)
               order by weight desc, client_id nulls last
    loop
      v_i := v_i + 1;
      if v_i = v_rows then
        v_alloc := ps.final_salary - v_running;
      else
        v_alloc := round(ps.final_salary * sp.weight, 2);
        v_running := v_running + v_alloc;
      end if;
      if v_alloc <> 0 then
        v_lines := v_lines || jsonb_build_array(
          v_emp || jsonb_build_object('key', v_key, 'debit', v_alloc, 'credit', 0,
                                      'client_id', sp.client_id));
      end if;
    end loop;
  end if;

  v_lines := v_lines || jsonb_build_array(
    v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', 0, 'credit', ps.final_salary));

  -- Employer statutory share is a direct cost of the client generating it (A3),
  -- so it splits the same way.
  if coalesce(ps.eobi_employer, 0) > 0 then
    v_i := 0; v_running := 0;
    for sp in select * from public.payslip_client_split(p_id)
               order by weight desc, client_id nulls last
    loop
      v_i := v_i + 1;
      if v_i = v_rows then
        v_alloc := ps.eobi_employer - v_running;
      else
        v_alloc := round(ps.eobi_employer * sp.weight, 2);
        v_running := v_running + v_alloc;
      end if;
      if v_alloc <> 0 then
        v_lines := v_lines || jsonb_build_array(
          v_emp || jsonb_build_object('key', 'cos_statutory', 'debit', v_alloc, 'credit', 0,
                                      'client_id', sp.client_id));
      end if;
    end loop;
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'eobi_payable', 'debit', 0, 'credit', ps.eobi_employer));
  end if;

  -- Deductions are employee-level, not client-level.
  if coalesce(ps.advance, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', ps.advance, 'credit', 0),
      v_emp || jsonb_build_object('key', 'employee_advances_receivable', 'debit', 0, 'credit', ps.advance));
  end if;

  if coalesce(ps.eobi, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable', 'debit', ps.eobi, 'credit', 0),
      v_emp || jsonb_build_object('key', 'eobi_payable',     'debit', 0, 'credit', ps.eobi));
  end if;

  if coalesce(ps.income_tax, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      v_emp || jsonb_build_object('key', 'salaries_payable',   'debit', ps.income_tax, 'credit', 0),
      v_emp || jsonb_build_object('key', 'salary_tax_payable', 'debit', 0, 'credit', ps.income_tax));
  end if;

  perform public.post_journal(
    ps.company_id, ps.period_month,
    'Payroll accrual — ' || left(ps.period_month::text, 7),
    'payslips', ps.id, false, v_lines, ps.branch_id);
end;
$function$;

-- Attendance can be corrected after a payslip is created, which changes the
-- split. Re-post the accrual when that happens rather than leaving the ledger
-- pinned to the attendance as it stood at payroll time.
create or replace function public.repost_payslip_accruals_for_month(
  p_company_id uuid, p_period_month date)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare p record; v_n integer := 0;
begin
  for p in select id from public.payslips
            where company_id = p_company_id and period_month = p_period_month
  loop
    perform public.reverse_journal_for_source(p_company_id, 'payslips', p.id, p_period_month);
    perform public.post_payslip_accrual(p.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$function$;

-- Repost everything onto the attendance-weighted split.
do $$
declare p record;
begin
  for p in select id, company_id, period_month from public.payslips loop
    perform public.reverse_journal_for_source(p.company_id, 'payslips', p.id, p.period_month);
    perform public.post_payslip_accrual(p.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The ledger and payroll_cost_by_client() must now agree per client, per month.
-- ---------------------------------------------------------------------------

create or replace function public.ledger_payroll_by_client(
  p_company_id uuid, p_period_month date)
returns table(client_id uuid, cost numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jl.client_id, round(sum(jl.debit - jl.credit), 2)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and je.source_table = 'payslips'
     and je.status = 'posted'
     and je.posting_period = date_trunc('month', p_period_month)::date
     and a.system_key in ('cos_payroll', 'opex_office_payroll')
     and jl.client_id is not null
   group by jl.client_id;
$function$;
