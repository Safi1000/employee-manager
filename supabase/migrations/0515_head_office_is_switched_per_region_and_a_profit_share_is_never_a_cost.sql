-- 0515 — Head office is switched per region. A profit share is never a cost.
--
-- DECIDED 2026-10-16 (Shayan), option (a): ISB/RWP absorbs ITS REVENUE SHARE of
-- head office; Lahore and AJK stay held. Reasons, for the next reader:
--   • (a) keeps A10's driver — head office apportioned by revenue. The
--     alternative, (b) all of head office to ISB/RWP, replaces apportionment
--     with assignment.
--   • (b)'s premise is too strong. Head office is co-located with ISB/RWP and
--     serves its clients, but its costs include the PTA licence and the guard
--     insurance, which cover every region's guards. 100% to ISB/RWP is as wrong
--     as 0%.
-- So the DENOMINATOR stays every region's revenue; only the regions switched on
-- take their share, and the held regions' shares stay at head office as the
-- named UNALLOCATED line (0514). September 2026, cash basis, measured before
-- writing: ISB/RWP carries 382,775.24, 176,194.76 stays unallocated; Nauman
-- 503,616.11, Shafqat -278,543.25 (unchanged — Lahore stays held), Shujaat
-- 1,473,582.14.
--
-- WHAT CHANGES
--   ho_apportionment_settings gains branch_id. A row with no branch is the
--   company default; a row with a branch speaks for that region. For a region
--   and month, the LATEST effective row of either kind wins; on the same month
--   the region's own row wins. So a later company-wide change resets every
--   region, and a region can be switched on its own.
--   ho_apportioned(co, month, branch)  — the setting for one region.
--   ho_apportionment                   — pool x (region weight / ALL weight),
--                                        only for regions switched on.
--   run_ho_cost_allocation             — posts what ho_apportionment says and
--                                        records the rest as unallocated. It
--                                        used to divide the pool among the
--                                        regions it allocated to, which under a
--                                        per-region switch would have been (b).
--   set_ho_apportionment               — takes a region (or none: every region).
--   ho_switch_impact                   — the price of one proposed change.
--   ho_region_modes                    — each region's mode for a month.
--
-- A PROFIT SHARE IS NEVER A COST. regional_partner_remuneration (6400) is a
-- partner's share of profit, posted as an expense to his own region by
-- run_profit_allocation. It cannot enter the head-office pool today — the pool
-- reads head-office lines only — but any GL-based reader of regional cost would
-- deduct it from the very region whose profit it was computed from, making a
-- partner's share a function of itself. The rule lives in
-- profit_share_expense_keys(): ho_pool reads it, and the account itself carries
-- the note, because a future reader of regional cost starts from the chart.
--
-- METHOD. Every function changed here was last written by one migration (0514,
-- or earlier for run_ho_cost_allocation) and is restated behind a digest
-- precondition: an unrecognised body is an edit nobody recorded, and the
-- migration refuses rather than overwrite it.

-- ---------------------------------------------------------------------------
-- 0. Digest preconditions.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_def text;
begin
  for r in select * from (values
    ('public.ho_apportioned(uuid,date)',                   'f647d8b6750afaf6b85b974587371663'),
    ('public.ho_apportioned_effective(uuid,date)',         '489b9e0efda01c2208e37844ce6be569'),
    ('public.ho_apportionment(uuid,date,date,text)',       'ab76c4cbdf9d99d5600c561c0f1a3069'),
    ('public.ho_apportionment_driver(uuid,uuid,date)',     'b6844cf0a0129f552a8311267d5ebc32'),
    ('public.ho_apportionment_impact(uuid,date)',          '7270346d3725e7590bed2944d51c9ff4'),
    ('public.ho_pool(uuid,date,date,text)',                '4cb6c16ca0b0900ea17eb37c35b53fdf'),
    ('public.partnership_run_blocker(uuid,date)',          '2ce8f881ec56f1bd5f0a0098364f22b3'),
    ('public.enforce_ho_exclusion_leaves_a_base()',        '189280ca0c90539b57f6c0f3ebecb4e1'),
    ('public.run_ho_cost_allocation(uuid,date,text)',      '67bee7c877cdcea597ffa45b59a07446'),
    ('public.set_ho_apportionment(uuid,date,boolean,text)','a57d9aae8aa2a74fbdac26fb7b66c5b0')
  ) as t(fn, md5)
  loop
    if to_regprocedure(r.fn) is null then continue; end if;          -- replay: dropped and recreated below
    v_def := pg_get_functiondef(r.fn::regprocedure);
    if position('0515' in v_def) > 0 then continue; end if;          -- replay
    if md5(v_def) <> r.md5 then
      raise exception '0515 REFUSED: % is not the body this migration was written against (md5 %, expected %).',
        r.fn, md5(v_def), r.md5;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The setting speaks per region.
-- ---------------------------------------------------------------------------
alter table public.ho_apportionment_settings
  add column if not exists branch_id uuid references public.branches(id);
alter table public.ho_apportionment_settings
  drop constraint if exists ho_apportionment_settings_company_id_effective_month_key;
create unique index if not exists ho_apportionment_settings_scope_month
  on public.ho_apportionment_settings (company_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_month);

comment on column public.ho_apportionment_settings.branch_id is
  '0515. NULL = the company default for every region; a branch = that region alone. For a region and month the latest effective row of either kind wins; on the same month the region''s own row wins.';

-- DECIDED 2026-10-16: ISB/RWP apportioned from the same month head office was
-- first held (2026-08 on GGS), so every month reads the same way.
insert into public.ho_apportionment_settings (company_id, branch_id, effective_month, apportion, reason)
select b.company_id, b.id, s.effective_month, true,
       'DECIDED 2026-10-16 (Shayan), option (a): ISB/RWP absorbs its revenue share of head office — co-located in Islamabad and serving its clients. Lahore and AJK stay held. Preserves A10''s revenue driver; (b), all of head office to ISB/RWP, was rejected as assignment, not apportionment — the PTA licence and guard insurance cover every region''s guards.'
  from public.branches b
  join public.companies c on c.id = b.company_id and c.name = 'GUARDS AND GUIDES (PVT) LTD'
  join public.ho_apportionment_settings s on s.company_id = b.company_id and s.branch_id is null
 where b.name = 'ISB/RWP' and not b.is_head_office
   and s.effective_month = (select min(x.effective_month) from public.ho_apportionment_settings x
                             where x.company_id = b.company_id and x.branch_id is null)
on conflict do nothing;

do $$
begin
  if (select count(*) from public.ho_apportionment_settings s
        join public.branches b on b.id = s.branch_id
       where b.name = 'ISB/RWP' and s.apportion
         and b.company_id = (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD')) <> 1 then
    raise exception '0515 FAILED: the ISB/RWP apportionment row for GGS is not exactly one.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. A profit share is never a cost.
-- ---------------------------------------------------------------------------
create or replace function public.profit_share_expense_keys()
returns text[]
language sql immutable
set search_path to 'public'
as $$ select array['regional_partner_remuneration']::text[] $$;

comment on function public.profit_share_expense_keys() is
  '0515. Expense accounts that carry a partner''s SHARE OF PROFIT, not a cost of running the business. run_profit_allocation posts a regional partner''s share as an expense to his own region. EVERY GL-based reader of regional or head-office cost must exclude these keys: deducting a partner''s share from the region it was computed from makes the share a function of itself. ho_pool excludes them.';

update public.chart_of_accounts
   set notes = 'PROFIT SHARE, NOT A COST (0515). A regional partner''s share of his region''s profit. Any reader of regional or head-office cost from the GL must exclude this account — see public.profit_share_expense_keys(). Counting it as a region''s cost makes the partner''s share a function of itself.'
 where system_key = any (public.profit_share_expense_keys())
   and notes is distinct from 'PROFIT SHARE, NOT A COST (0515). A regional partner''s share of his region''s profit. Any reader of regional or head-office cost from the GL must exclude this account — see public.profit_share_expense_keys(). Counting it as a region''s cost makes the partner''s share a function of itself.';

-- ---------------------------------------------------------------------------
-- 3. The setting, per region.
-- ---------------------------------------------------------------------------
drop function if exists public.ho_apportioned(uuid, date);
create or replace function public.ho_apportioned(p_company_id uuid, p_month date, p_branch_id uuid default null)
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_month)::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
  end if;
  -- 0515. THE SETTING, and nothing else — postings read this, never a preview
  -- override. Latest effective row of the region's own or the company default
  -- wins; on the same month the region's own row wins. No row reads OFF.
  return coalesce((
    select s.apportion from public.ho_apportionment_settings s
     where s.company_id = p_company_id
       and s.effective_month <= v_m
       and (s.branch_id is null or s.branch_id = p_branch_id)
     order by s.effective_month desc, (s.branch_id is not null) desc
     limit 1), false);
end $$;

create or replace function public.ho_any_apportioned(p_company_id uuid, p_month date)
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0515. Is any region taking head office this month? (The setting only.)
  return exists (select 1 from public.branches b
                  where b.company_id = p_company_id and b.active and not b.is_head_office
                    and public.ho_apportioned(p_company_id, p_month, b.id));
end $$;

drop function if exists public.ho_apportioned_effective(uuid, date);
create or replace function public.ho_apportioned_effective(p_company_id uuid, p_month date, p_branch_id uuid)
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $$
declare v_raw text := nullif(current_setting('bastion.ho_mode_override', true), ''); v jsonb;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
  end if;
  -- 0515. READ PATH ONLY. The override is a JSON object set transaction-local
  -- by the price functions: {"<branch_id>": "on"|"off"} for one region,
  -- {"all": "on"|"off"} for every region. Postings clear it before computing.
  if v_raw is not null then
    v := v_raw::jsonb;
    if p_branch_id is not null and v ? p_branch_id::text then return v ->> p_branch_id::text = 'on'; end if;
    if v ? 'all' then return v ->> 'all' = 'on'; end if;
  end if;
  return public.ho_apportioned(p_company_id, p_month, p_branch_id);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The pool's named list gains the profit-share rule.
-- ---------------------------------------------------------------------------
create or replace function public.ho_pool(p_company_id uuid, p_start date, p_end date, p_basis text default 'accrual')
returns numeric
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  -- THE EXCLUSIONS, NAMED. Each sits at head office but is not an overhead the
  -- regions consume, or is the allocation's own posting.
  v_excluded constant text[] := array[
    'income_tax',          -- DECIDED (Shayan, 2026-10-16): tax on profit is not overhead.
    'bonus_expense',       -- DECIDED (Shayan, 2026-10-16): the bonus provision stays out, as before.
    'allocated_ho_cost',   -- the allocation's own debit; pooling it would apportion the apportionment.
    'ho_cost_recovery'     -- the allocation's own credit; same reason.
  ] || public.profit_share_expense_keys();  -- 0515: a partner's share is never a cost (see that function).
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

comment on function public.ho_pool(uuid, date, date, text) is
  '0514/0515. THE head-office pool. Accrual = GL expense lines on the head-office region; cash = what head office paid. Exclusions are a named list in the body: income_tax and bonus_expense (DECIDED 2026-10-16), the allocation''s own two accounts, and profit_share_expense_keys() (0515: a partner''s share is never a cost).';

-- ---------------------------------------------------------------------------
-- 5. THE apportionment, per region: denominator every region, share only to
--    the regions switched on.
-- ---------------------------------------------------------------------------
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
  -- 0515, option (a). For each month: the pool, times this client's weight over
  -- EVERY region's weight, paid only by clients in a region switched on. A held
  -- region's share is not redistributed — it stays at head office, unallocated.
  v_m := date_trunc('month', p_start)::date;
  while v_m <= p_end loop
    v_me := (v_m + interval '1 month - 1 day')::date;
    select coalesce(sum(d.weight), 0) into v_tot from public.ho_driver(p_company_id, v_m, v_me) d;
    if v_tot > 0 then
      v_pool := public.ho_pool(p_company_id, greatest(v_m, p_start), least(v_me, p_end), p_basis);
      if v_pool <> 0 then
        return query
        select d.client_id, d.branch_id, v_pool * d.weight / v_tot
          from public.ho_driver(p_company_id, v_m, v_me) d
         where d.weight > 0
           and public.ho_apportioned_effective(p_company_id, v_m, d.branch_id);
      end if;
    end if;
    v_m := (v_m + interval '1 month')::date;
  end loop;
end $$;

comment on function public.ho_apportionment(uuid, date, date, text) is
  '0514/0515. pool x (client weight / every region''s weight), for clients in regions switched on (option (a), DECIDED 2026-10-16). Held regions'' shares stay at head office. Every reader of head-office apportionment reads this.';

-- ---------------------------------------------------------------------------
-- 6. The switch, per region, and its price.
-- ---------------------------------------------------------------------------
drop function if exists public.set_ho_apportionment(uuid, date, boolean, text);
create or replace function public.set_ho_apportionment(p_company_id uuid, p_effective_month date, p_apportion boolean, p_reason text, p_branch_id uuid default null)
returns uuid
language plpgsql security definer
set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_effective_month)::date; v_closed date; v_id uuid; v_user uuid;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is null then raise exception 'A company is required.' using errcode = '22023'; end if;
  perform public.assert_same_company(p_company_id);
  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
    if not exists (select 1 from public.branches where id = p_branch_id and company_id = p_company_id and not is_head_office) then
      raise exception 'Head-office apportionment is set per region; head office itself has no setting.' using errcode = '22023';
    end if;
  end if;
  perform public.require_perm('accounting.edit');
  if p_effective_month is null or p_apportion is null then
    raise exception 'An effective month and an on/off value are required.' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Say why head-office apportionment is changing. The reason is kept with the setting.' using errcode = '22023';
  end if;
  select min(period_month) into v_closed from public.accounting_periods
   where company_id = p_company_id and period_month >= v_m;
  if v_closed is not null then
    raise exception 'Head-office apportionment cannot change from %: % is closed, and this change would restate it. Choose a month after the last closed period.',
      to_char(v_m, 'FMMonth YYYY'), to_char(v_closed, 'FMMonth YYYY') using errcode = 'P0001';
  end if;
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  update public.ho_apportionment_settings
     set apportion = p_apportion, reason = btrim(p_reason), set_by = v_user, set_at = now()
   where company_id = p_company_id and branch_id is not distinct from p_branch_id and effective_month = v_m
  returning id into v_id;
  if v_id is null then
    insert into public.ho_apportionment_settings (company_id, branch_id, effective_month, apportion, reason, set_by, set_at)
    values (p_company_id, p_branch_id, v_m, p_apportion, btrim(p_reason), v_user, now())
    returning id into v_id;
  end if;
  if v_id is null then raise exception '0515: setting not written.'; end if;
  return v_id;
end $$;

create or replace function public.ho_region_modes(p_company_id uuid, p_month date)
returns table(branch_id uuid, region_name text, apportioned boolean, own_setting boolean, decided_from date)
language plpgsql stable security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare v_m date := date_trunc('month', p_month)::date;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- 0515. Each region's mode for the month, whether its OWN row decides it
  -- (false = it follows the company default), and the month of the row that
  -- decides it. The screen uses decided_from to name, before a company-wide
  -- change saves, every region whose own setting that change would override:
  -- a company row from month M overrides a region row only if the region row
  -- took effect before M (on the same month the region's row wins).
  return query
  with d as (
    select b.id, b.name::text as nm,
           (select s from public.ho_apportionment_settings s
             where s.company_id = p_company_id and s.effective_month <= v_m
               and (s.branch_id is null or s.branch_id = b.id)
             order by s.effective_month desc, (s.branch_id is not null) desc limit 1) as s
      from public.branches b
     where b.company_id = p_company_id and b.active and not b.is_head_office
  )
  select d.id, d.nm,
         coalesce((d.s).apportion, false),
         coalesce((d.s).branch_id is not null, false),
         (d.s).effective_month
    from d
   order by d.nm;
end $$;

create or replace function public.ho_switch_impact(p_company_id uuid, p_period date, p_branch_id uuid, p_apportion boolean)
returns table(partner_id uuid, partner_name text, row_kind text, current_amount numeric, proposed_amount numeric, difference numeric)
language plpgsql volatile security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_m   date := date_trunc('month', p_period)::date;
  v_e   date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_now jsonb; v_new jsonb;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company looked up from p_branch_id
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
  end if;
  -- 0515. THE PRICE OF ONE CHANGE: every partner's share for the month as the
  -- settings stand, and with this region (or every region, when none is named)
  -- switched to p_apportion. Read-only; the override is transaction-local and
  -- cleared before returning.
  begin
    perform set_config('bastion.ho_mode_override', '', true);
    select coalesce(jsonb_object_agg(a.partner_id::text, jsonb_build_object('n', a.partner_name, 'k', a.row_kind, 'v', a.amount)), '{}')
      into v_now from public.partnership_allocation(v_m, v_e, null, p_company_id) a
     where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    perform set_config('bastion.ho_mode_override',
      jsonb_build_object(coalesce(p_branch_id::text, 'all'), case when p_apportion then 'on' else 'off' end)::text, true);
    select coalesce(jsonb_object_agg(a.partner_id::text, jsonb_build_object('n', a.partner_name, 'k', a.row_kind, 'v', a.amount)), '{}')
      into v_new from public.partnership_allocation(v_m, v_e, null, p_company_id) a
     where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    perform set_config('bastion.ho_mode_override', '', true);
  exception when others then
    perform set_config('bastion.ho_mode_override', '', true);
    raise;
  end;
  return query
  select k::uuid, coalesce(v_now->k->>'n', v_new->k->>'n'), coalesce(v_now->k->>'k', v_new->k->>'k'),
         (v_now->k->>'v')::numeric, (v_new->k->>'v')::numeric,
         coalesce((v_new->k->>'v')::numeric, 0) - coalesce((v_now->k->>'v')::numeric, 0)
    from (select jsonb_object_keys(v_now) k union select jsonb_object_keys(v_new)) ks
   order by 3 desc, 2;
end $$;

-- 0514's both-ways price, kept for any reader: every region on vs every region off.
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
  -- 0515: every region on vs every region off, through the JSON override.
  begin
    perform set_config('bastion.ho_mode_override', '{"all":"on"}', true);
    select coalesce(jsonb_object_agg(a.partner_id::text, jsonb_build_object('n', a.partner_name, 'k', a.row_kind, 'v', a.amount)), '{}')
      into v_on from public.partnership_allocation(v_m, v_e, null, p_company_id) a
     where a.row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    perform set_config('bastion.ho_mode_override', '{"all":"off"}', true);
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

-- ---------------------------------------------------------------------------
-- 7. The readers that ask "is head office apportioned", per region.
-- ---------------------------------------------------------------------------
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
  -- 0515: the region's weight (sum of its clients' ho_driver weights). This is
  -- the WEIGHT, whatever the region's setting: under option (a) a held region
  -- still counts in the denominator. Whether it TAKES its share is
  -- ho_apportioned(co, month, region).
  return coalesce((select sum(d.weight) from public.ho_driver(p_company_id, v_m, (v_m + interval '1 month - 1 day')::date) d
                    where d.branch_id = p_branch_id), 0);
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

  -- 0514/0515: held at head office by decision is not stranded. Only a month in
  -- which some region is switched on can strand anything.
  if not public.ho_any_apportioned(p_company_id, v_start) then return null; end if;

  v_pool := public.ho_pool(p_company_id, v_start, v_end, 'accrual');
  select coalesce(sum(d.weight), 0) into v_base from public.ho_driver(p_company_id, v_start, v_end) d;

  if coalesce(v_pool, 0) = 0 then return null; end if;
  if coalesce(v_base, 0) > 0 then return null; end if;

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

  -- 0514/0515: while no region takes head office, an exclusion strands nothing.
  if not public.ho_any_apportioned(new.company_id, v_month) then return new; end if;

  v_pool := coalesce(public.ho_overhead_for_month(new.company_id, v_month), 0);
  if v_pool = 0 then return new; end if;   -- nothing to strand

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

-- The GL posting path. Posts exactly what ho_apportionment says, per region,
-- and records the rest — held regions' shares and the named exclusions — as
-- unallocated. It used to divide the whole pool among whichever regions it
-- allocated to: under a per-region switch that would have been option (b).
create or replace function public.run_ho_cost_allocation(p_company_id uuid, p_period date, p_basis text default 'revenue')
returns numeric
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_month     date := date_trunc('month', p_period)::date;
  v_mend      date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v_ho        uuid := public.head_office_region(p_company_id);
  v_basis     text := lower(coalesce(p_basis, 'revenue'));
  v_cost      numeric;
  v_total     numeric;
  v_target    numeric;
  v_alloc_sum numeric := 0;
  v_lines     jsonb := '[]'::jsonb;
  v_run       uuid;
  v_top       uuid;
  r           record;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  -- Refuse a closed month AT THE DOOR (0250).
  if public.is_period_closed(p_company_id, v_month) then
    raise exception
      'Period % is closed. run_ho_cost_allocation reverses and reposts the whole month, which would restate a closed period. Reopen the month in Period Close first.',
      v_month using errcode = 'P0001';
  end if;

  -- 0515: a posting reads the setting, never a preview override.
  perform set_config('bastion.ho_mode_override', '', true);

  v_cost := public.ho_pool(p_company_id, v_month, v_mend, 'accrual');
  select coalesce(sum(d.weight), 0) into v_total from public.ho_driver(p_company_id, v_month, v_mend) d;

  select id into v_run from public.ho_allocation_runs
   where company_id = p_company_id and period_month = v_month;
  if v_run is not null then
    perform public.reverse_journal_for_source(p_company_id, 'ho_allocation', v_run, v_mend);
  end if;

  if v_run is null then
    insert into public.ho_allocation_runs (company_id, period_month, basis, ho_cost, total_deployed)
    values (p_company_id, v_month, v_basis, v_cost, v_total) returning id into v_run;
  else
    update public.ho_allocation_runs
       set basis = v_basis, ho_cost = v_cost, total_deployed = v_total, updated_at = now()
     where id = v_run;
  end if;

  -- THE apportionment, summed to the region, rounded to the paisa; the rounding
  -- difference against the rounded total goes to the largest share.
  select round(coalesce(sum(a.ho_share), 0), 2) into v_target
    from public.ho_apportionment(p_company_id, v_month, v_mend, 'accrual') a;

  for r in
    select a.branch_id, round(sum(a.ho_share), 2) as amt
      from public.ho_apportionment(p_company_id, v_month, v_mend, 'accrual') a
     group by a.branch_id
    having round(sum(a.ho_share), 2) <> 0
     order by 2 desc, 1
  loop
    if v_top is null then
      v_top := r.branch_id;
      r.amt := r.amt + (v_target - (select round(coalesce(sum(x.amt), 0), 2) from (
                 select round(sum(a.ho_share), 2) amt
                   from public.ho_apportionment(p_company_id, v_month, v_mend, 'accrual') a
                  group by a.branch_id) x));
    end if;
    v_alloc_sum := v_alloc_sum + r.amt;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'key', 'allocated_ho_cost', 'debit', r.amt, 'credit', 0, 'region', r.branch_id));
  end loop;

  if v_alloc_sum = 0 then
    update public.ho_allocation_runs
       set allocated_total = 0, unallocated = greatest(coalesce(v_cost, 0), 0)
     where id = v_run;
    return 0;
  end if;

  if v_alloc_sum <> v_target then
    raise exception '0515: HO allocation posts % against an apportionment of % for %', v_alloc_sum, v_target, v_month
      using errcode = '23514';
  end if;

  v_lines := v_lines || jsonb_build_array(jsonb_build_object(
    'key', 'ho_cost_recovery', 'debit', 0, 'credit', v_alloc_sum, 'region', v_ho));

  perform public.post_journal(
    p_company_id, v_mend,
    'Head-office cost allocation ' || to_char(v_month, 'YYYY-MM'),
    'ho_allocation', v_run, false, v_lines, v_ho);

  update public.ho_allocation_runs
     set allocated_total = v_alloc_sum, unallocated = v_cost - v_alloc_sum
   where id = v_run;
  return v_alloc_sum;
end $$;

revoke all on function public.ho_apportioned(uuid, date, uuid), public.ho_any_apportioned(uuid, date),
  public.ho_apportioned_effective(uuid, date, uuid), public.set_ho_apportionment(uuid, date, boolean, text, uuid),
  public.ho_region_modes(uuid, date), public.ho_switch_impact(uuid, date, uuid, boolean),
  public.profit_share_expense_keys() from public, anon;
grant execute on function public.ho_apportioned(uuid, date, uuid), public.ho_any_apportioned(uuid, date),
  public.ho_apportioned_effective(uuid, date, uuid), public.set_ho_apportionment(uuid, date, boolean, text, uuid),
  public.ho_region_modes(uuid, date), public.ho_switch_impact(uuid, date, uuid, boolean),
  public.profit_share_expense_keys() to authenticated, service_role;

comment on function public.set_ho_apportionment(uuid, date, boolean, text, uuid) is
  '0515. The only writer of ho_apportionment_settings. p_branch_id = one region, NULL = every region (company default). accounting.edit; a reason is required; refuses a change that would reach a closed month.';
comment on function public.ho_switch_impact(uuid, date, uuid, boolean) is
  '0515. The price of one proposed change: every partner''s share for the month as set, and with the named region (or every region) switched. For the screen that flips it.';

-- ---------------------------------------------------------------------------
-- 8. ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare r record; v_pool numeric; v_on numeric; v_all numeric; v_share numeric; v_reg numeric; v_cli numeric;
begin
  for r in
    select c.id co, c.name, m.m, (m.m + interval '1 month - 1 day')::date e,
           public.partner_basis_for_report(null, c.id) basis
      from public.companies c
     cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 3) k) m
  loop
    -- 8a. Option (a): the regions switched on take exactly their revenue share
    -- of the pool — not the whole pool (that is (b)), and nothing to a held region.
    v_pool := public.ho_pool(r.co, r.m, r.e, case when r.basis = 'cash' then 'cash' else 'accrual' end);
    select coalesce(sum(d.weight), 0),
           coalesce(sum(d.weight) filter (where public.ho_apportioned(r.co, r.m, d.branch_id)), 0)
      into v_all, v_on from public.ho_driver(r.co, r.m, r.e) d;
    select coalesce(sum(a.ho_share), 0) into v_share
      from public.ho_apportionment(r.co, r.m, r.e, case when r.basis = 'cash' then 'cash' else 'accrual' end) a;
    if v_all > 0 and abs(v_share - v_pool * v_on / v_all) > 0.01 then
      raise exception '0515 FAILED: % % apportions % where its regions switched on carry % of %.',
        r.name, to_char(r.m, 'YYYY-MM'), v_share, round(v_pool * v_on / v_all, 2), v_pool;
    end if;
    if exists (select 1 from public.ho_apportionment(r.co, r.m, r.e, 'accrual') a
                where not public.ho_apportioned(r.co, r.m, a.branch_id)) then
      raise exception '0515 FAILED: % % apportioned head office to a held region.', r.name, to_char(r.m, 'YYYY-MM');
    end if;

    -- 8b. The region level, the client level and the apportionment agree.
    select coalesce(-sum(a.ho_allocated), 0) into v_reg
      from public.partnership_allocation(r.m, r.e, null, r.co) a
     where a.row_kind = 'REGION' and a.branch_id is distinct from public.head_office_region(r.co);
    select coalesce(sum(s.ho_share), 0) into v_cli
      from public.client_statement_loaded(r.m, r.e, r.basis, r.co) s where s.client_id is not null;
    if abs(v_reg - v_share) > 0.01 then
      raise exception '0515 FAILED: % % regions carry %, ho_apportionment %.', r.name, to_char(r.m, 'YYYY-MM'), v_reg, v_share;
    end if;
    if abs(v_cli - v_share) > 0.01 * greatest(1, (select count(*) from public.clients where company_id = r.co)) then
      raise exception '0515 FAILED: % % clients carry %, ho_apportionment %.', r.name, to_char(r.m, 'YYYY-MM'), v_cli, v_share;
    end if;

    -- 8c. A partner in a held region does not move: his share as set equals his
    -- share with every region held.
    if exists (
      select 1
        from public.partnership_allocation(r.m, r.e, null, r.co) a
        join public.ho_switch_impact(r.co, r.m, null, false) b on b.partner_id = a.partner_id
       where a.row_kind = 'REGIONAL_PARTNER'
         and not public.ho_apportioned(r.co, r.m, a.branch_id)
         and abs(coalesce(a.amount, 0) - coalesce(b.proposed_amount, 0)) > 0.005) then
      raise exception '0515 FAILED: % % a partner in a held region moved with another region''s switch.', r.name, to_char(r.m, 'YYYY-MM');
    end if;
  end loop;

  -- 8c'. The screen's list of overridden regions reads ho_region_modes; it must
  -- report exactly the mode the setting resolves to, or the list would lie.
  if exists (select 1 from public.companies c
               cross join (select (date_trunc('month', current_date) - (k || ' months')::interval)::date m from generate_series(0, 3) k) m
               cross join lateral public.ho_region_modes(c.id, m.m) x
              where x.apportioned <> public.ho_apportioned(c.id, m.m, x.branch_id)) then
    raise exception '0515 FAILED: ho_region_modes disagrees with ho_apportioned.';
  end if;

  -- 8d. A partner's share is never a cost.
  if position('profit_share_expense_keys()' in pg_get_functiondef('public.ho_pool(uuid,date,date,text)'::regprocedure)) = 0 then
    raise exception '0515 FAILED: ho_pool does not exclude profit_share_expense_keys().';
  end if;

  -- 8e. Postings never honour the preview override.
  perform set_config('bastion.ho_mode_override', '{"all":"on"}', true);
  if exists (select 1 from public.branches b
              where not b.is_head_office
                and public.ho_apportioned(b.company_id, current_date, b.id)
                    <> coalesce((select s.apportion from public.ho_apportionment_settings s
                                  where s.company_id = b.company_id and s.effective_month <= current_date
                                    and (s.branch_id is null or s.branch_id = b.id)
                                  order by s.effective_month desc, (s.branch_id is not null) desc limit 1), false)) then
    raise exception '0515 FAILED: ho_apportioned() honoured the preview override.';
  end if;
  perform set_config('bastion.ho_mode_override', '', true);
  if position($q$set_config('bastion.ho_mode_override', '', true)$q$ in
              pg_get_functiondef('public.run_ho_cost_allocation(uuid,date,text)'::regprocedure)) = 0 then
    raise exception '0515 FAILED: run_ho_cost_allocation does not clear the preview override.';
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
    raise exception '0515 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
