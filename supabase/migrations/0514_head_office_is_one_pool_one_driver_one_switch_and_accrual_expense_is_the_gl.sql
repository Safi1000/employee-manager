-- 0514 — Head office: one pool, one driver, one switch. Accrual expense is the GL.
--
-- Part B of the September 2026 audit. Decisions (Shayan, 2026-10-16):
--   1. POOL = THE GL. Accrual reads GL expense lines; cash reads what was
--      actually paid. Income tax and bonus stay excluded, as an explicit named
--      list (ho_pool), not a buried filter.
--   2. DRIVER = GL REVENUE BY SERVICE MONTH, AT CLIENT GRAIN (ho_driver). A
--      region's figure is the sum of its clients', so the two levels cannot
--      disagree.
--   3. OFF, effective from the earliest month that has data. Head office is a
--      named UNALLOCATED line in every statement, never dropped.
--   4. The accrual expense fix lands here: regional and client accrual expense
--      read the GL, so there is one definition of accrual, not two.
--
-- WHAT THERE WAS. Four implementations of one rule, over three pools:
--   partnership_allocation   driver regional_pl_range revenue; pool = head
--                            office's own regional P&L row
--   client_statement_loaded  driver invoices by service month; pool = head
--                            office overhead from raw expenses.amount
--   run_ho_cost_allocation   driver invoice_lines (ho_apportionment_driver);
--   + ho_exclusion_preview,  pool = GL head-office lines (ho_overhead_for_month)
--     enforce_ho_exclusion_leaves_a_base
--   partnership_run_blocker  pool = head office's regional accrual profit;
--                            base = regional_pl_range revenue
-- September accrual: 664,530 / 664,530 / 418,530. The 246,000 difference was
-- raw expenses.amount read as "accrual": PTA licence 180,000 paid, 30,000
-- released; head-office rent 96,000 for August service. The same defect put
-- ISB's full 281,563 insurance payment into September where the GL releases
-- 46,927.17.
--
-- WHAT THERE IS NOW. One table and four functions, read by everything:
--   ho_apportionment_settings   effective-dated on/off per company
--   ho_apportioned(co, month)   the setting (postings read only this)
--   ho_pool(co, start, end, basis)      THE pool
--   ho_driver(co, start, end)           THE driver, per client
--   ho_apportionment(co, start, end, basis)   pool x driver x setting, per client
-- client_statement_loaded sums ho_apportionment to the client and adds the
-- HEAD OFFICE - UNALLOCATED line; partnership_allocation sums it to the
-- region; run_ho_cost_allocation, ho_exclusion_preview, the exclusion trigger
-- and partnership_run_blocker read ho_pool / ho_driver / the setting.
--
-- THE PRICE OF THE SWITCH. ho_apportionment_impact(co, month) computes every
-- partner's share both ways for the screen that flips the setting. Measured on
-- September 2026, cash basis, HMC Taxila at 37.5% (DECIDED): Nauman 503,616.11
-- apportioned vs 616,679.91 held (+113,063.80); Shafqat -305,296.68 vs
-- -278,543.25 (+26,753.43); Shujaat's residual falls by their sum, 139,817.23.
-- It previews through a transaction-local override (bastion.ho_mode_override)
-- that ONLY the read path honours: ho_apportioned() ignores it, and
-- run_profit_allocation clears it before computing, so no session can post a
-- run under a previewed mode.
--
-- METHOD. Functions edited by many migrations (client_statement_loaded,
-- partnership_allocation, regional_pl_range, run_profit_allocation) are amended
-- by surgery against the live definition, each anchor asserted exactly once and
-- skipped on replay. The five small functions this pass replaces wholesale
-- (ho_apportionment_driver, ho_overhead_for_month, ho_exclusion_preview,
-- enforce_ho_exclusion_leaves_a_base, partnership_run_blocker) are restated
-- only behind a digest precondition: each must be exactly the body read on
-- 2026-10-16, or the migration refuses — an unrecognised body is an edit
-- nobody recorded, and restating over it would destroy it.
--
-- NOT CHANGED, AND SAID SO: regional and client ACCRUAL PAYROLL still read
-- payslips.final_salary, not the GL. The GL also carries payroll_adjustments
-- (September: 2,011). Small, and a separate question from expense.
-- DEFERRED: whether regional_partner_remuneration belongs in the exclusion
-- list. No run has posted it; if one posts it to head office, it would enter
-- the pool. The change is one array element in ho_pool.

-- ---------------------------------------------------------------------------
-- 0. Digest preconditions for the five restated functions.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_def text;
begin
  for r in select * from (values
    ('public.ho_apportionment_driver(uuid,uuid,date)',          '6960d677201dc1f2968d6d8593d65869'),
    ('public.ho_overhead_for_month(uuid,date)',                 '4c26ebd812604010a24066f76f97bc85'),
    ('public.ho_exclusion_preview(uuid,date,uuid[])',           'f6f9f0174f57c206d6ba77699a88c47a'),
    ('public.enforce_ho_exclusion_leaves_a_base()',             '97ac422c59c52a35452e184fed27d4ce'),
    ('public.partnership_run_blocker(uuid,date)',               'b0fe13b54f873333122af76a2195e8a7')
  ) as t(fn, md5)
  loop
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position('0514' in v_def) > 0 then continue; end if;   -- replay
    if md5(v_def) <> r.md5 then
      raise exception '0514 REFUSED: % is not the body this migration was written against (md5 %, expected %). Re-read it before restating.',
        r.fn, md5(v_def), r.md5;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The setting.
-- ---------------------------------------------------------------------------
create table if not exists public.ho_apportionment_settings (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  effective_month date not null check (effective_month = date_trunc('month', effective_month)::date),
  apportion       boolean not null,
  reason          text not null check (length(btrim(reason)) > 0),
  set_by          uuid,
  set_at          timestamptz not null default now(),
  unique (company_id, effective_month)
);
alter table public.ho_apportionment_settings enable row level security;
drop policy if exists company_members_read on public.ho_apportionment_settings;
create policy company_members_read on public.ho_apportionment_settings
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.ho_apportionment_settings;
create policy ssa_read on public.ho_apportionment_settings
  for select using ((select public.is_ssa_unscoped()));
-- No write policy: the only writer is set_ho_apportionment().

comment on table public.ho_apportionment_settings is
  '0514. Is head-office cost apportioned to clients and regions, from which month. Effective-dated: a month reads the latest row at or before it; no row reads OFF. DECIDED 2026-10-16 (Shayan): OFF from each company''s earliest month with data — the regions are not consuming head office yet; it will be switched on when they do. Written only by set_ho_apportionment(), which refuses any change that would reach a closed month.';

insert into public.ho_apportionment_settings (company_id, effective_month, apportion, reason)
select c.id,
       date_trunc('month', least(
         (select min(je.entry_date)    from public.journal_entries je where je.company_id = c.id),
         (select min(i.service_month)  from public.invoices i        where i.company_id = c.id),
         (select min(p.period_month)   from public.payslips p        where p.company_id = c.id),
         (select min(e.expense_date)   from public.expenses e        where e.company_id = c.id)))::date,
       false,
       'DECIDED 2026-10-16 (Shayan): head office is not apportioned until the regions consume it. Held at head office as a named UNALLOCATED line. Effective from the earliest month with data, so every month reads the same way.'
  from public.companies c
 where least(
         (select min(je.entry_date)    from public.journal_entries je where je.company_id = c.id),
         (select min(i.service_month)  from public.invoices i        where i.company_id = c.id),
         (select min(p.period_month)   from public.payslips p        where p.company_id = c.id),
         (select min(e.expense_date)   from public.expenses e        where e.company_id = c.id)) is not null
on conflict (company_id, effective_month) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The four functions.
-- ---------------------------------------------------------------------------
create or replace function public.ho_apportioned(p_company_id uuid, p_month date)
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- THE SETTING, and nothing else. Postings read this; it never honours the
  -- preview override.
  return coalesce((
    select s.apportion from public.ho_apportionment_settings s
     where s.company_id = p_company_id
       and s.effective_month <= date_trunc('month', p_month)::date
     order by s.effective_month desc
     limit 1), false);
end $$;

create or replace function public.ho_apportioned_effective(p_company_id uuid, p_month date)
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $$
declare v text := nullif(current_setting('bastion.ho_mode_override', true), '');
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- READ PATH ONLY. ho_apportionment_impact sets the override, transaction-
  -- local, to price the switch; run_profit_allocation clears it.
  if v = 'on'  then return true;  end if;
  if v = 'off' then return false; end if;
  return public.ho_apportioned(p_company_id, p_month);
end $$;

create or replace function public.ho_pool(p_company_id uuid, p_start date, p_end date, p_basis text default 'accrual')
returns numeric
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  -- THE EXCLUSIONS, NAMED. Each is a cost that sits at head office but is not
  -- an overhead the regions consume, or is the allocation's own posting.
  v_excluded constant text[] := array[
    'income_tax',          -- DECIDED (Shayan, 2026-10-16): tax on profit is not overhead.
    'bonus_expense',       -- DECIDED (Shayan, 2026-10-16): the bonus provision stays out, as before.
    'allocated_ho_cost',   -- the allocation's own debit; pooling it would apportion the apportionment.
    'ho_cost_recovery'     -- the allocation's own credit; same reason.
  ];
  v_ho  uuid;
  v_amt numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  v_ho := public.head_office_region(p_company_id);

  if lower(coalesce(p_basis, 'accrual')) = 'cash' then
    -- CASH: what head office actually paid in the window, on the same cash
    -- dates the statements use (a cheque counts when it clears).
    select coalesce(sum(ps.net_salary), 0) into v_amt
      from public.payslips ps
      join public.employees e on e.id = ps.employee_id
      left join public.cheques ch on ch.id = ps.cheque_id
     where e.company_id = p_company_id and e.branch_id = v_ho and ps.disbursed
       and (case when ps.payment_mode = 'Cheque'
                 then case when ch.status = 'cleared' then ch.cleared_at::date end
                 else coalesce(ps.disbursed_at::date, ps.period_month) end)
           between p_start and p_end;

    select v_amt + coalesce(sum(x.amount), 0) into v_amt
      from public.expenses x
      left join public.clients c on c.id = x.client_id
      left join public.cheques ch on ch.id = x.cheque_id
      left join public.expense_categories ec on ec.id = x.category_id
     where x.company_id = p_company_id
       and coalesce(x.branch_id, c.branch_id) = v_ho
       and x.client_id is null
       and public.map_expense_to_coa_key(coalesce(ec.name, ''), x.pl_category::text, x.client_id) <> all (v_excluded)
       and (case when x.payment_mode in ('Cash','Bank') then x.expense_date
                 when x.payment_mode = 'Cheque'
                   then case when ch.status = 'cleared' then ch.cleared_at::date end
                 when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end)
           between p_start and p_end;
    return v_amt;
  end if;

  -- ACCRUAL: the GL. Every expense line on the head-office region in the
  -- window, payroll included, less the named exclusions.
  select coalesce(sum(jl.debit - jl.credit), 0) into v_amt
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
   where je.company_id = p_company_id
     and jl.branch_id = v_ho
     and a.account_type = 'expense'
     and coalesce(a.system_key, '') <> all (v_excluded)
     and je.entry_date between p_start and p_end;
  return v_amt;
end $$;

create or replace function public.ho_driver(p_company_id uuid, p_start date, p_end date)
returns table(client_id uuid, branch_id uuid, revenue numeric, weight numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- GL revenue by SERVICE month (the GL posts invoices there, A4), per client,
  -- in the region of the revenue line. weight is what absorbs head office: a
  -- region excluded by 0353 (ho_excluded) or head office itself weighs zero.
  return query
  select jl.client_id,
         coalesce(jl.branch_id, c.branch_id),
         sum(jl.credit - jl.debit),
         case when coalesce(b.ho_excluded, false) or coalesce(b.is_head_office, false) then 0
              else greatest(sum(jl.credit - jl.debit), 0) end
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    join public.chart_of_accounts a on a.id = jl.account_id
    left join public.clients c on c.id = jl.client_id
    left join public.branches b on b.id = coalesce(jl.branch_id, c.branch_id)
   where je.company_id = p_company_id
     and a.account_type = 'revenue'
     and jl.client_id is not null
     and je.entry_date between p_start and p_end
   group by jl.client_id, coalesce(jl.branch_id, c.branch_id), b.ho_excluded, b.is_head_office;
end $$;

create or replace function public.ho_apportionment(p_company_id uuid, p_start date, p_end date, p_basis text default 'accrual')
returns table(client_id uuid, branch_id uuid, ho_share numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare v_m date; v_me date; v_pool numeric; v_tot numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- Month by month, because the setting is effective-dated: a window spanning
  -- the month it was switched on apportions only the months after.
  v_m := date_trunc('month', p_start)::date;
  while v_m <= p_end loop
    v_me := (v_m + interval '1 month - 1 day')::date;
    if public.ho_apportioned_effective(p_company_id, v_m) then
      v_pool := public.ho_pool(p_company_id, greatest(v_m, p_start), least(v_me, p_end), p_basis);
      select coalesce(sum(d.weight), 0) into v_tot from public.ho_driver(p_company_id, v_m, v_me) d;
      if v_pool <> 0 and v_tot > 0 then
        return query
        select d.client_id, d.branch_id, v_pool * d.weight / v_tot
          from public.ho_driver(p_company_id, v_m, v_me) d
         where d.weight > 0;
      end if;
    end if;
    v_m := (v_m + interval '1 month')::date;
  end loop;
end $$;

comment on function public.ho_pool(uuid, date, date, text) is
  '0514. THE head-office pool. Accrual = GL expense lines on the head-office region; cash = what head office paid. Exclusions are a named list in the body: income_tax and bonus_expense (DECIDED 2026-10-16), and the allocation''s own two accounts. DEFERRED: regional_partner_remuneration — add it to the list if a profit run ever posts it to head office.';
comment on function public.ho_driver(uuid, date, date) is
  '0514. THE head-office driver: GL revenue by service month, per client. Region = sum of its clients. ho_excluded regions and head office weigh zero.';
comment on function public.ho_apportionment(uuid, date, date, text) is
  '0514. pool x driver x setting, per client. Every reader of head-office apportionment reads this: client_statement_loaded sums it to the client, partnership_allocation to the region.';

-- ---------------------------------------------------------------------------
-- 3. The switch and its price.
-- ---------------------------------------------------------------------------
create or replace function public.set_ho_apportionment(p_company_id uuid, p_effective_month date, p_apportion boolean, p_reason text)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_effective_month)::date; v_closed date; v_id uuid; v_user uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is null then raise exception 'A company is required.' using errcode = '22023'; end if;
  perform public.assert_same_company(p_company_id);
  perform public.require_perm('accounting.edit');
  if p_effective_month is null or p_apportion is null then
    raise exception 'An effective month and an on/off value are required.' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Say why head-office apportionment is changing. The reason is kept with the setting.' using errcode = '22023';
  end if;
  -- A change effective from v_m reads into every later month, so it must not
  -- reach a closed one. Refuse rather than restate.
  select min(period_month) into v_closed from public.accounting_periods
   where company_id = p_company_id and period_month >= v_m;
  if v_closed is not null then
    raise exception 'Head-office apportionment cannot change from %: % is closed, and this change would restate it. Choose a month after the last closed period.',
      to_char(v_m, 'FMMonth YYYY'), to_char(v_closed, 'FMMonth YYYY') using errcode = 'P0001';
  end if;
  begin v_user := auth.uid(); exception when others then v_user := null; end;
  insert into public.ho_apportionment_settings (company_id, effective_month, apportion, reason, set_by, set_at)
  values (p_company_id, v_m, p_apportion, btrim(p_reason), v_user, now())
  on conflict (company_id, effective_month)
  do update set apportion = excluded.apportion, reason = excluded.reason, set_by = excluded.set_by, set_at = excluded.set_at
  returning id into v_id;
  if v_id is null then raise exception '0514: setting not written.'; end if;
  return v_id;
end $$;

create or replace function public.ho_apportionment_impact(p_company_id uuid, p_period date)
returns table(partner_id uuid, partner_name text, row_kind text, apportioned numeric, held numeric, difference numeric)
language plpgsql volatile security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_m  date := date_trunc('month', p_period)::date;
  v_e  date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_on  jsonb;
  v_off jsonb;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- THE PRICE OF THE SWITCH: every partner's share for the month, apportioned
  -- and held, on the company's remuneration basis. Read-only; the override is
  -- transaction-local and cleared before returning.
  begin
    perform set_config('bastion.ho_mode_override', 'on', true);
    select coalesce(jsonb_object_agg(a.partner_id::text, jsonb_build_object('n', a.partner_name, 'k', a.row_kind, 'v', a.amount)), '{}')
      into v_on from public.partnership_allocation(v_m, v_e, null, p_company_id) a
     where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    perform set_config('bastion.ho_mode_override', 'off', true);
    select coalesce(jsonb_object_agg(a.partner_id::text, jsonb_build_object('n', a.partner_name, 'k', a.row_kind, 'v', a.amount)), '{}')
      into v_off from public.partnership_allocation(v_m, v_e, null, p_company_id) a
     where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    perform set_config('bastion.ho_mode_override', '', true);
  exception when others then
    perform set_config('bastion.ho_mode_override', '', true);
    raise;
  end;
  return query
  select k::uuid, coalesce(v_on->k->>'n', v_off->k->>'n'), coalesce(v_on->k->>'k', v_off->k->>'k'),
         (v_on->k->>'v')::numeric, (v_off->k->>'v')::numeric,
         coalesce((v_off->k->>'v')::numeric, 0) - coalesce((v_on->k->>'v')::numeric, 0)
    from (select jsonb_object_keys(v_on) k union select jsonb_object_keys(v_off)) ks
   order by 3 desc, 2;
end $$;

comment on function public.set_ho_apportionment(uuid, date, boolean, text) is
  '0514. The only writer of ho_apportionment_settings. accounting.edit; a reason is required; refuses a change that would reach a closed month.';
comment on function public.ho_apportionment_impact(uuid, date) is
  '0514. Every partner''s share for a month with head office apportioned and held, for the screen that flips the switch — so nobody flips it without seeing the price.';

revoke all on function public.ho_apportioned(uuid, date), public.ho_apportioned_effective(uuid, date),
  public.ho_pool(uuid, date, date, text), public.ho_driver(uuid, date, date),
  public.ho_apportionment(uuid, date, date, text), public.set_ho_apportionment(uuid, date, boolean, text),
  public.ho_apportionment_impact(uuid, date) from public, anon;
grant execute on function public.ho_apportioned(uuid, date), public.ho_apportioned_effective(uuid, date),
  public.ho_pool(uuid, date, date, text), public.ho_driver(uuid, date, date),
  public.ho_apportionment(uuid, date, date, text), public.set_ho_apportionment(uuid, date, boolean, text),
  public.ho_apportionment_impact(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The five restated functions (digest-checked in step 0).
-- ---------------------------------------------------------------------------
create or replace function public.ho_overhead_for_month(p_company_id uuid, p_period date)
returns numeric
language plpgsql stable security definer
set search_path to 'public'
as $$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0514: the accrual pool for one month IS ho_pool. Kept as a name because
  -- run_ho_cost_allocation and ho_exclusion_preview read it.
  return public.ho_pool(p_company_id, date_trunc('month', p_period)::date,
                        (date_trunc('month', p_period) + interval '1 month - 1 day')::date, 'accrual');
end $$;

create or replace function public.ho_apportionment_driver(p_company_id uuid, p_branch_id uuid, p_period date)
returns numeric
language plpgsql stable security definer
set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_period)::date;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
  end if;
  -- 0514: a region's weight is the sum of its clients' ho_driver weights
  -- (ho_excluded and head office already weigh zero there), and zero in a
  -- month the setting holds head office back. run_ho_cost_allocation, the GL
  -- posting path, reads the SETTING (ho_apportioned), never a preview override.
  if not public.ho_apportioned(p_company_id, v_m) then return 0; end if;
  return coalesce((select sum(d.weight) from public.ho_driver(p_company_id, v_m, (v_m + interval '1 month - 1 day')::date) d
                    where d.branch_id = p_branch_id), 0);
end $$;

create or replace function public.ho_exclusion_preview(p_company_id uuid, p_period date, p_excluded uuid[] default null::uuid[])
returns table(branch_id uuid, region_name text, invoiced numeric, excluded_now boolean, excluded_after boolean, absorbs_now numeric, absorbs_after numeric, delta numeric)
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  v_month date := date_trunc('month', p_period)::date;
  v_pool  numeric;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  v_pool := coalesce(public.ho_overhead_for_month(p_company_id, v_month), 0);

  return query
  with drv as (
    -- 0514: raw GL revenue per region from ho_driver, ignoring BOTH the current
    -- exclusion flag and the proposed one, so each scenario applies its own.
    select d.branch_id as b, sum(d.revenue) as inv
      from public.ho_driver(p_company_id, v_month, (v_month + interval '1 month - 1 day')::date) d
     group by 1
  ),
  b as (
    select br.id, br.name::text as nm, br.ho_excluded,
           coalesce(br.id = any(coalesce(p_excluded, array[]::uuid[])), false) as prop,
           coalesce((select drv.inv from drv where drv.b = br.id), 0) as inv
      from public.branches br
     where br.company_id = p_company_id and br.active and not br.is_head_office
  ),
  w as (
    select b.*,
           case when b.ho_excluded then 0 else greatest(b.inv, 0) end as w_now,
           case when b.prop        then 0 else greatest(b.inv, 0) end as w_aft
      from b
  ),
  t as (select coalesce(sum(w_now), 0) tn, coalesce(sum(w_aft), 0) ta from w)
  select w.id, w.nm, w.inv, w.ho_excluded, w.prop,
         round(case when t.tn > 0 then v_pool * w.w_now / t.tn else 0 end, 2),
         round(case when t.ta > 0 then v_pool * w.w_aft / t.ta else 0 end, 2),
         round(case when t.ta > 0 then v_pool * w.w_aft / t.ta else 0 end
             - case when t.tn > 0 then v_pool * w.w_now / t.tn else 0 end, 2)
    from w cross join t
   order by w.nm;
end $$;

create or replace function public.enforce_ho_exclusion_leaves_a_base()
returns trigger
language plpgsql
set search_path to 'public', 'extensions'
as $$
declare
  v_month date := date_trunc('month', current_date)::date;
  v_base  numeric;
  v_pool  numeric;
begin
  if new.ho_excluded is not true or old.ho_excluded is true then
    return new;                       -- clearing or unchanged: always allowed
  end if;

  -- 0514: while the setting holds head office back, an exclusion strands
  -- nothing, because nothing is being apportioned.
  if not public.ho_apportioned(new.company_id, v_month) then return new; end if;

  v_pool := coalesce(public.ho_overhead_for_month(new.company_id, v_month), 0);
  if v_pool = 0 then return new; end if;   -- nothing to strand

  -- What would still be able to absorb, counting this row as excluded (0514:
  -- ho_driver weights, which already zero excluded regions and head office).
  select coalesce(sum(d.weight), 0) into v_base
    from public.ho_driver(new.company_id, v_month, (v_month + interval '1 month - 1 day')::date) d
   where d.branch_id is distinct from new.id;

  if coalesce(v_base, 0) <= 0 then
    raise exception
      'Excluding % would leave no region able to absorb head office cost this month, so the whole pool of % would be stranded rather than redistributed. Exclude it in a month where another region has invoiced revenue, or clear another region''s exclusion first.',
      new.name, v_pool
      using errcode = 'P0001';
  end if;

  return new;
end $$;

create or replace function public.partnership_run_blocker(p_company_id uuid, p_period date)
returns text
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  v_start date := date_trunc('month', p_period)::date;
  v_end   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_pool  numeric;
  v_base  numeric;
  v_live  int;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- 0514: held at head office by decision is not stranded. Nothing to block.
  if not public.ho_apportioned(p_company_id, v_start) then return null; end if;

  -- 0514: the pool and base are THE pool and THE driver.
  v_pool := public.ho_pool(p_company_id, v_start, v_end, 'accrual');
  select coalesce(sum(d.weight), 0) into v_base from public.ho_driver(p_company_id, v_start, v_end) d;

  -- Nothing to apportion: a zero denominator cannot do any harm.
  if coalesce(v_pool, 0) = 0 then return null; end if;
  if coalesce(v_base, 0) > 0 then return null; end if;

  -- There IS a pool and nothing to spread it over. Say which cause.
  select count(*) into v_live
    from public.contracts c
    join public.clients cl on cl.id = c.client_id
   where cl.company_id = p_company_id
     and c.status <> 'draft'
     and c.start_date <= v_end
     and (c.end_date is null or c.end_date >= v_start)
     and (c.termination_date is null or c.termination_date >= v_start);

  if v_live > 0 then
    return to_char(v_start, 'FMMonth YYYY') || '''s invoices have not been raised; the head office pool of '
        || to_char(v_pool, 'FM999,999,999.00') || ' cannot be apportioned. '
        || v_live || ' contract(s) were live that month, so invoiced revenue is expected — raise the invoices, then run the allocation.';
  end if;

  return 'No billable contract was active in ' || to_char(v_start, 'FMMonth YYYY')
      || ', so there is no invoiced revenue to apportion the head office pool of '
      || to_char(v_pool, 'FM999,999,999.00') || ' over. This is not a timing problem — nothing was billed at all.';
end $$;

-- ---------------------------------------------------------------------------
-- 5. Surgery on the readers that have no canonical file.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.surg0514(p_fn text, p_key text, p_old text, p_new text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_new in v_def) > 0 then
    raise notice '0514: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0514 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.surg0514($f$public.regional_pl_range(date,date,uuid)$f$, $k$rpl_exp$k$, $a$  exp_a as (
    select coalesce(x.branch_id, c.branch_id) as b, sum(x.amount)::numeric as amt
      from public.expenses x left join public.clients c on c.id = x.client_id cross join cid
     where x.company_id = cid.company_id and x.expense_date between p_start and p_end group by 1
  ),
$a$, $b$  exp_a as (
    -- 0514. Accrual expense is what the GL recognised in the period, placed in
    -- the region of the expense behind each line. A prepaid or service-period
    -- expense reaches cost through its release schedule (0347/0356), never as
    -- its raw amount on the day it was paid.
    select coalesce(jl.branch_id, x.branch_id, c.branch_id) as b, sum(jl.debit - jl.credit)::numeric as amt
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
      join public.expenses x on x.id = je.source_id
      left join public.clients c on c.id = x.client_id
      cross join cid
     where je.company_id = cid.company_id
       and je.source_table in ('expenses', 'expenses_prepaid_release')
       and a.account_type = 'expense'
       and je.entry_date between p_start and p_end group by 1
  ),
$b$);
select pg_temp.surg0514($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_exp$k$, $a$  exp_rows as (
    select x.client_id, x.branch_id, x.amount::numeric as amount,
           case when cash.on_cash then
                  case when x.payment_mode in ('Cash','Bank') then x.expense_date
                       when x.payment_mode = 'Cheque'
                         then case when ch.status = 'cleared' then ch.cleared_at::date end
                       when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end
                else x.expense_date end as eff_date
      from public.expenses x
      left join public.cheques ch on ch.id = x.cheque_id
      cross join cid cross join cash
     where x.company_id = cid.company_id
  ),
$a$, $b$  exp_rows as (
    -- 0514. CASH basis: the expense on the day its cash left (unchanged).
    select x.client_id, x.branch_id, x.amount::numeric as amount,
           case when x.payment_mode in ('Cash','Bank') then x.expense_date
                when x.payment_mode = 'Cheque'
                  then case when ch.status = 'cleared' then ch.cleared_at::date end
                when x.payment_mode = 'Payable' and x.payable_status = 'Paid' then x.paid_at::date end as eff_date
      from public.expenses x
      left join public.cheques ch on ch.id = x.cheque_id
      cross join cid cross join cash
     where x.company_id = cid.company_id and cash.on_cash
    union all
    -- 0514. ACCRUAL basis: what the GL recognised, when it recognised it. A
    -- prepaid or service-period expense reaches cost through its release
    -- schedule, never as its raw amount on the day it was paid.
    select x.client_id, coalesce(jl.branch_id, x.branch_id), (jl.debit - jl.credit)::numeric, je.entry_date
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
      join public.expenses x on x.id = je.source_id
      cross join cid cross join cash
     where je.company_id = cid.company_id and not cash.on_cash
       and je.source_table in ('expenses', 'expenses_prepaid_release')
       and a.account_type = 'expense'
  ),
$b$);
select pg_temp.surg0514($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_ro$k$, $a$  region_overhead as (
$a$, $b$  ho_alloc as (
    -- 0514. THE head-office apportionment: one pool (ho_pool), one driver
    -- (ho_driver), under the effective-dated setting. No rows while it is off.
    select a.client_id, sum(a.ho_share) as amt
      from public.ho_apportionment((select company_id from cid), p_start, p_end,
             case when lower(p_basis) = 'cash' then 'cash' else 'accrual' end) a
     where a.client_id is not null
     group by 1
  ),
  region_overhead as (
$b$);
select pg_temp.surg0514($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_tail$k$, $a$  left join rev_region rr on rr.b is not distinct from cl.branch_id
  order by cl.name;
$a$, $b$  left join rev_region rr on rr.b is not distinct from cl.branch_id
  left join ho_alloc ha on ha.client_id = cl.id
  union all
  -- 0514. HEAD OFFICE - UNALLOCATED. What head office cost on this basis less
  -- what was apportioned to clients. Never dropped: with apportionment off it
  -- is the whole pool; on, it is what the driver could not place plus the
  -- named exclusions. Net summed over every row is the company result.
  select null::uuid, 'HEAD OFFICE - UNALLOCATED'::text, 'HO-UNALLOCATED'::text,
         public.head_office_region((select company_id from cid)), 'Head Office'::text,
         0::numeric, 0::numeric, 0::numeric, 0::numeric,
         round(ho.pool - (select coalesce(sum(amt), 0) from ho_alloc), 2),
         round((select coalesce(sum(amt), 0) from ho_alloc) - ho.pool, 2)
    from ho
   where abs(ho.pool - (select coalesce(sum(amt), 0) from ho_alloc)) > 0.005
  order by 2;
$b$);
select pg_temp.surg0514($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_ho_share$k$, $a$    round(ho.pool * case when rt.amt > 0 then coalesce(drv.amt, 0) / rt.amt else 0 end, 2),
$a$, $b$    round(coalesce(ha.amt, 0), 2),  /* 0514: ho_apportionment */
$b$);
select pg_temp.surg0514($f$public.client_statement_loaded(date,date,text,uuid)$f$, $k$cs_ho_net$k$, $a$      - ho.pool * case when rt.amt > 0 then coalesce(drv.amt, 0) / rt.amt else 0 end, 2)
$a$, $b$      - coalesce(ha.amt, 0), 2)  /* 0514: ho_apportionment */
$b$);
select pg_temp.surg0514($f$public.partnership_allocation(date,date,text,uuid)$f$, $k$pa_un$k$, $a$         ho.ho_profit, ho.ho_profit, null::numeric
    from ho where ho.rev_base <= 0 and ho.ho_profit <> 0
$a$, $b$         pl.profit, pl.profit, null::numeric
    from pl where pl.is_ho and abs(pl.profit) > 0.005  /* 0514: what stays at head office, named */
$b$);
select pg_temp.surg0514($f$public.partnership_allocation(date,date,text,uuid)$f$, $k$pa_ho$k$, $a$  ho as (
    select coalesce(sum(profit) filter (where is_ho), 0) as ho_profit,
           coalesce(sum(greatest(revenue, 0)) filter (where not is_ho), 0) as rev_base
      from raw
  ),
  adj as (
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
           case
             when ho.rev_base <= 0 then 0
             when raw.is_ho then -raw.profit
             else ho.ho_profit * greatest(raw.revenue, 0) / ho.rev_base
           end as ho_allocated
      from raw cross join ho
  ),
$a$, $b$  ho_alloc as (
    -- 0514. THE head-office apportionment (ho_apportionment): one pool, one
    -- driver at client grain, summed here to the region. client_statement_loaded
    -- sums the same rows to the client, so the two levels cannot disagree.
    select a.branch_id, sum(a.ho_share) as amt
      from public.ho_apportionment((select company_id from cid), p_start, p_end,
             case when (select basis from cfg) = 'cash' then 'cash' else 'accrual' end) a
     group by 1
  ),
  adj as (
    select raw.branch_id, raw.region_name, raw.is_ho, raw.profit as own_profit,
           case
             when raw.is_ho then coalesce((select sum(amt) from ho_alloc), 0)
             else -coalesce((select ha.amt from ho_alloc ha
                              where ha.branch_id is not distinct from raw.branch_id), 0)
           end as ho_allocated
      from raw
  ),
$b$);
select pg_temp.surg0514($f$public.run_profit_allocation(uuid,date,text,boolean)$f$, $k$rpa_run$k$, $a$  select id, status into v_run, v_status
    from public.profit_allocation_runs
$a$, $b$  perform set_config('bastion.ho_mode_override', '', true);  -- 0514: a posting reads the setting, never a preview override
  select id, status into v_run, v_status
    from public.profit_allocation_runs
$b$);

-- ---------------------------------------------------------------------------
-- 6. ASSERTIONS. Each names the failure it guards against and can see it.
-- ---------------------------------------------------------------------------
do $$
declare v_bad int; v_txt text; r record; v_pool numeric; v_share numeric; v_reg numeric; v_cli numeric;
begin
  -- 6a. Accrual expense is the GL. A region still reading raw expenses.amount
  -- disagrees with the GL in any month holding a prepaid or service-period
  -- expense (September 2026 on GGS: the 281,563 insurance payment).
  select count(*), string_agg(c.name || ' ' || to_char(m.m, 'YYYY-MM'), ', ') into v_bad, v_txt
    from public.companies c
   cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 3) k) m
   where (select coalesce(sum(rp.expenses_accrual), 0)
            from public.regional_pl_range(m.m, (m.m + interval '1 month - 1 day')::date, c.id) rp)
      <> (select coalesce(sum(jl.debit - jl.credit), 0)
            from public.journal_lines jl
            join public.journal_entries je on je.id = jl.journal_entry_id
            join public.chart_of_accounts a on a.id = jl.account_id
           where je.company_id = c.id and a.account_type = 'expense'
             and je.source_table in ('expenses', 'expenses_prepaid_release')
             and je.entry_date between m.m and (m.m + interval '1 month - 1 day')::date);
  if v_bad > 0 then
    raise exception '0514 FAILED: regional accrual expense disagrees with the GL for: %', v_txt;
  end if;

  -- 6b. OFF means nothing is apportioned AND nothing is dropped. For every
  -- company and recent month the setting holds back, on both statement bases:
  -- ho_apportionment returns no rows, no client carries a head-office share,
  -- and the HEAD OFFICE - UNALLOCATED line is present whenever head office had
  -- cost. And on the company's partner basis, no region carries an allocation.
  for r in
    select c.id co, c.name, m.m, (m.m + interval '1 month - 1 day')::date e, b.basis
      from public.companies c
     cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 3) k) m
     cross join (values ('cash'), ('revenue')) b(basis)
     where not public.ho_apportioned(c.id, m.m)
  loop
    if exists (select 1 from public.ho_apportionment(r.co, r.m, r.e, case when r.basis = 'cash' then 'cash' else 'accrual' end)) then
      raise exception '0514 FAILED: % % is OFF but ho_apportionment apportioned head office.', r.name, to_char(r.m, 'YYYY-MM');
    end if;
    if exists (select 1 from public.client_statement_loaded(r.m, r.e, r.basis, r.co) s
                where s.client_id is not null and abs(s.ho_share) > 0.005) then
      raise exception '0514 FAILED: % % (%) is OFF but a client statement carries a head-office share.', r.name, to_char(r.m, 'YYYY-MM'), r.basis;
    end if;
    select coalesce(sum(s.ho_share), 0) into v_share
      from public.client_statement_loaded(r.m, r.e, r.basis, r.co) s where s.client_code = 'HO-UNALLOCATED';
    select coalesce(sum(case when r.basis = 'cash' then x.payroll_cash + x.expenses_cash
                             else x.payroll_accrual + x.expenses_accrual end), 0)
      into v_pool
      from public.regional_pl_range(r.m, r.e, r.co) x
      join public.branches b on b.id = x.branch_id and b.is_head_office;
    if v_pool <> 0 and v_share = 0 then
      raise exception '0514 FAILED: % % (%) is OFF, head office cost %, and no HEAD OFFICE - UNALLOCATED line was produced: the cost was dropped.',
        r.name, to_char(r.m, 'YYYY-MM'), r.basis, v_pool;
    end if;
    if r.basis = 'cash' and exists (
         select 1 from public.partnership_allocation(r.m, r.e, null, r.co) a
          where a.row_kind = 'REGION' and abs(coalesce(a.ho_allocated, 0)) > 0.005) then
      raise exception '0514 FAILED: % % is OFF but a region carries a head-office allocation.', r.name, to_char(r.m, 'YYYY-MM');
    end if;
  end loop;

  -- 6c. ON, the pool is exhausted and the region level equals the client
  -- level, both equal to ho_apportionment itself. Forced on through the
  -- read-path override, on each company's partner basis, then cleared.
  perform set_config('bastion.ho_mode_override', 'on', true);
  for r in
    select c.id co, c.name, m.m, (m.m + interval '1 month - 1 day')::date e,
           public.partner_basis_for_report(null, c.id) basis
      from public.companies c
     cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 3) k) m
  loop
    v_pool := public.ho_pool(r.co, r.m, r.e, case when r.basis = 'cash' then 'cash' else 'accrual' end);
    select coalesce(sum(ho_share), 0) into v_share
      from public.ho_apportionment(r.co, r.m, r.e, case when r.basis = 'cash' then 'cash' else 'accrual' end);
    if v_share <> 0 and abs(v_share - v_pool) > 0.01 then
      raise exception '0514 FAILED: % % apportions % of a pool of %.', r.name, to_char(r.m, 'YYYY-MM'), v_share, v_pool;
    end if;
    select coalesce(-sum(a.ho_allocated), 0) into v_reg
      from public.partnership_allocation(r.m, r.e, null, r.co) a
     where a.row_kind = 'REGION' and a.branch_id is distinct from public.head_office_region(r.co);
    select coalesce(sum(s.ho_share), 0) into v_cli
      from public.client_statement_loaded(r.m, r.e, r.basis, r.co) s where s.client_id is not null;
    if abs(v_reg - v_share) > 0.01 then
      raise exception '0514 FAILED: % % regions carry % of head office, ho_apportionment %.', r.name, to_char(r.m, 'YYYY-MM'), v_reg, v_share;
    end if;
    if abs(v_cli - v_share) > 0.01 * greatest(1, (select count(*) from public.clients where company_id = r.co)) then
      raise exception '0514 FAILED: % % clients carry % of head office, ho_apportionment %.', r.name, to_char(r.m, 'YYYY-MM'), v_cli, v_share;
    end if;
  end loop;
  perform set_config('bastion.ho_mode_override', '', true);

  -- 6d. Postings never honour the preview override.
  perform set_config('bastion.ho_mode_override', 'on', true);
  if exists (select 1 from public.companies c where public.ho_apportioned(c.id, current_date)
                                                 <> coalesce((select s.apportion from public.ho_apportionment_settings s
                                                               where s.company_id = c.id and s.effective_month <= current_date
                                                               order by s.effective_month desc limit 1), false)) then
    raise exception '0514 FAILED: ho_apportioned() honoured the preview override.';
  end if;
  perform set_config('bastion.ho_mode_override', '', true);
  if position($q$set_config('bastion.ho_mode_override', '', true)$q$ in
              pg_get_functiondef('public.run_profit_allocation(uuid,date,text,boolean)'::regprocedure)) = 0 then
    raise exception '0514 FAILED: run_profit_allocation does not clear the preview override.';
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
    raise exception '0514 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
