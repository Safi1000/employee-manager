-- Danger level & bands (spec §9.5, D4) + rolling cash forecast (§9.1).
--
-- §9.5: minimum cash = next payroll + statutory falling due + 0.5 x monthly
-- fixed overheads (the 0.5 is a stored parameter). Bands: Green > 1.5x min,
-- Amber 1–1.5x, Red < min. In Red, a non-payroll/non-statutory disbursement is
-- a BLOCKING action requiring COO override, logged.
--
-- §9.1: an 8–13 week forward view of expected collections vs committed
-- outflows, projected balance per week, first breach week flagged.

-- D4 parameters live in finance_settings.
alter table public.finance_settings
  add column if not exists overhead_multiplier numeric(4,2) not null default 0.50,
  add column if not exists green_band_multiplier numeric(4,2) not null default 1.50;

-- ===========================================================================
-- 1. The minimum-cash floor.
-- ===========================================================================

-- Average monthly fixed overhead: opex expense over the last 3 months / 3.
create or replace function public.avg_monthly_overhead(p_company_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(round(sum(jl.debit - jl.credit) / 3.0, 2), 0)
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and a.account_type = 'expense'
     and a.system_key like 'opex_%'
     and je.entry_date >= (date_trunc('month', current_date) - interval '3 months')::date;
$$;

-- Statutory falling due within the next month (unpaid filings).
create or replace function public.statutory_due_soon(p_company_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)
    from public.statutory_filings
   where company_id = p_company_id and paid_date is null
     and due_date <= current_date + 30;
$$;

-- min cash = next month net payroll + statutory due + overhead_multiplier x overhead
create or replace function public.minimum_cash(p_company_id uuid)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare fs record;
begin
  select * into fs from public.finance_settings where company_id = p_company_id;
  return round(
    public.avg_monthly_net_payroll(p_company_id)
    + public.statutory_due_soon(p_company_id)
    + coalesce(fs.overhead_multiplier, 0.5) * public.avg_monthly_overhead(p_company_id), 2);
end;
$$;

-- Company-wide danger band from available cash (after reserves).
create or replace view public.danger_level
  with (security_invoker = true) as
  select cc.company_id,
         cc.available_after_reserves as available_cash,
         public.minimum_cash(cc.company_id) as min_cash,
         case when public.minimum_cash(cc.company_id) > 0
              then round(cc.available_after_reserves / public.minimum_cash(cc.company_id), 2) end as ratio,
         case
           when cc.available_after_reserves < public.minimum_cash(cc.company_id) then 'red'
           when cc.available_after_reserves <
                public.minimum_cash(cc.company_id)
                * (select coalesce(green_band_multiplier,1.5) from public.finance_settings f
                    where f.company_id = cc.company_id) then 'amber'
           else 'green'
         end as band
    from public.cash_cockpit cc;

-- ===========================================================================
-- 2. Disbursement guard (spec §9.5): in Red, a non-payroll/non-statutory
--    disbursement is blocked pending COO override (logged as a blocking alert).
-- ===========================================================================

create or replace function public.check_disbursement(
  p_company_id uuid, p_amount numeric, p_is_payroll_or_statutory boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare v_band text;
begin
  select band into v_band from public.danger_level where company_id = p_company_id;

  -- Payroll and statutory always flow, even in Red (they are the floor itself).
  if coalesce(p_is_payroll_or_statutory, false) then
    return 'allowed';
  end if;

  if v_band = 'red' then
    perform public.raise_alert(p_company_id, 'blocking', 'danger_level_disbursement',
      'Disbursement of ' || p_amount || ' blocked: cash is in the RED danger band. '
      || 'COO override required.', null, null, null);
    return 'blocked';
  end if;
  return 'allowed';
end;
$$;

-- ===========================================================================
-- 3. Rolling 8–13 week cash forecast (§9.1).
--    Weekly buckets: expected collections in (unpaid invoices assumed to land
--    ~30 days after invoice date) vs committed outflows (statutory due, pending
--    cheques, and a weekly slice of payroll + overhead). First breach flagged.
-- ===========================================================================

create or replace function public.cash_forecast(p_company_id uuid, p_weeks integer default 13)
returns table (
  week_no        integer,
  week_start     date,
  opening_balance numeric,
  expected_inflow numeric,
  expected_outflow numeric,
  closing_balance numeric,
  is_breach      boolean
) language plpgsql stable security definer set search_path = public as $$
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
  -- Start from available cash after reserves.
  select available_after_reserves into v_open from public.cash_cockpit where company_id = p_company_id;
  v_open := coalesce(v_open, 0);
  v_weekly_payroll  := round(public.avg_monthly_net_payroll(p_company_id) / 4.33, 2);
  v_weekly_overhead := round(public.avg_monthly_overhead(p_company_id) / 4.33, 2);

  for i in 1 .. greatest(p_weeks, 1) loop
    v_ws := (date_trunc('week', current_date) + ((i - 1) || ' weeks')::interval)::date;
    v_we := v_ws + 6;

    -- Inflows: unpaid invoices expected ~30 days after invoicing. An overdue
    -- receivable (its +30 date already past) is expected imminently, so bucket
    -- by greatest(invoice_date+30, today) — otherwise overdue AR would drop out
    -- of the forecast entirely and understate collections.
    select coalesce(sum(coalesce(inv.total_due, inv.invoice_amount) - inv.amount_received), 0)
      into v_in
      from public.invoices inv
     where inv.company_id = p_company_id
       and inv.amount_received < coalesce(inv.total_due, inv.invoice_amount)
       and greatest(inv.invoice_date + 30, current_date) between v_ws and v_we;

    -- Outflows: statutory due + pending cheques falling in the week, plus the
    -- steady weekly payroll and overhead slices.
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
$$;

-- First breach week for a company (null = no breach in the horizon).
create or replace function public.first_breach_week(p_company_id uuid, p_weeks integer default 13)
returns date language sql stable security definer set search_path = public as $$
  select min(week_start) from public.cash_forecast(p_company_id, p_weeks) where is_breach;
$$;

-- ===========================================================================
-- 4. Now that the full reserve set exists (§9.2), the cash cockpit's
--    "available after reserves" must net ALL restricted reserves, not just the
--    bonus one it launched with.
-- ===========================================================================

create or replace view public.cash_cockpit
  with (security_invoker = true) as
  with bal as (
    select je.company_id,
           sum(case when a.system_key = 'bank' then jl.debit - jl.credit else 0 end)
             + sum(case when a.parent_id in
                          (select id from public.chart_of_accounts where system_key = 'cash')
                        then jl.debit - jl.credit else 0 end)
             + sum(case when a.system_key = 'cash' then jl.debit - jl.credit else 0 end) as gross_cash,
           sum(case when a.system_key in
                          ('bonus_reserve','payroll_reserve','statutory_reserve',
                           'asset_replacement_reserve','emergency_reserve')
                    then jl.debit - jl.credit else 0 end) as reserves
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     group by je.company_id
  ),
  outflow as (
    select je.company_id,
           round(sum(case a.account_type when 'expense' then jl.debit - jl.credit else 0 end)
                 / 90.0, 2) as avg_daily_outflow
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.entry_date >= current_date - 90
     group by je.company_id
  )
  select b.company_id, b.gross_cash, b.reserves,
         b.gross_cash - b.reserves as available_after_reserves,
         o.avg_daily_outflow,
         case when coalesce(o.avg_daily_outflow, 0) > 0
              then round((b.gross_cash - b.reserves) / o.avg_daily_outflow, 1) end as days_runway
    from bal b left join outflow o on o.company_id = b.company_id;
