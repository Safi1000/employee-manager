-- 0573 — Lahore settled from Shafqat's new statement, profit declared per client
--
-- Supersedes the 0546 draft (written 22 Oct, never applied, held at Shayan's
-- word). Built on Maj Shafqat Ali Raza's "LAHORE REPORTS" (28 Oct 2026):
-- "Berger Sep-26" and "All Popular Brand Sep-26" (Jun–Sep). DECIDED 28 Oct:
--
--   * The 15% "share of investment" was NOT agreed — it is not on the new
--     statement and is not entered.
--   * Lahore's profit is DECLARED PER CLIENT: region_declared_profit gains a
--     client column. A region's month is declared either as one figure or per
--     client, never both (declare_region_profit refuses a mix).
--   * Shujaat's Lahore line shows both: GGS's 55% profit, and beside it what
--     GGS kept including the PRA it holds — so each declared row carries
--     pra_held, the PRA withheld from Shafqat to be paid by head office.
--
-- Carried from the 0546 decisions (22 Oct): declared in OCTOBER (both clients
-- paid in October; the partnership runs on cash received), September 0;
-- Shafqat's 45% and every Lahore cost are EXPENSES from his cash holding, so
-- his holding nets to nothing once the transfers are recorded; Popular's costs
-- are divided among its four clients by revenue (Jun–Sep invoices); weapons
-- and the metal detector are expensed; the holding may go negative until the
-- transfers to him are recorded; the expenses are left unapproved for Shayan.
--
-- Bastion already holds every receipt: Berger Aug 750,527 (6 Oct), Berger
-- Sep 800,385 (21 Oct), and the four Popular clients 2,540,558.42 (21 Oct;
-- the statement's 2,540,556 to rounding). What is entered here is Shafqat's
-- side, from his holding:
--
--   Berger, August — his 45% (already with him since the 9 Oct transfer) 58,699
--   Berger, September                                                      678,103
--     salaries 464,000 · rent 8,000 · electricity 8,010 · transport 700
--     share paid to Maj Khalid 103,000 · 45% Shafqat 94,393
--   Popular, Jun–Sep (split across the four clients)                     2,088,624
--     salaries 1,557,580 · uniforms and shoes 5,700 · weapons 98,000
--     metal detector 19,000 · transportation 9,000 · welfare 14,000
--     APSA Uber 1,900 · APSA fee 14,700 · goodwill to Sub sb 20,000
--     45% Shafqat 348,744
--                                                                       ─────────
--   his holding falls by                                                2,825,426
--   from 58,699 to −2,766,727 = the 678,103 + 2,088,624 to be sent to him.
--
-- The 45% of Popular is split by each client's own profit (receipt − its PRA −
-- its revenue share of the costs), so each client's 55% and 45% are its own.
--
-- Declared for October 2026, per client (GGS 55%; PRA held beside it):
--   Berger Paints        187,113  (Aug 71,743 + Sep 115,370)    PRA  6,912
--   Popular Brands        69,554                                  PRA  4,292
--   Popular Water Tank    68,837                                  PRA  4,143
--   Waheed Shahzad       145,929                                  PRA  8,627
--   AlRabi               141,923                                  PRA  8,627
--                        613,356                                       32,601
-- September 2026: 0 (one row, no client).
--
-- NOT entered: the transfers of 678,103 and 2,088,624 to Shafqat (record each
-- when sent: a bank-to-custodian withdrawal, bringing his holding back to 0);
-- PRA 32,601 (a Lahore expense when head office pays it). The audit check
-- no_payroll_booked_as_expense gains the salary rows: Lahore's guards are paid
-- by Shafqat, not through Bastion payroll.
--
-- Function changes:
--   * declare_region_profit (0537 its only author) — dropped behind a digest
--     precondition and re-created with p_client_id and p_pra_held (both
--     optional, so the existing four-argument call keeps working).
--   * partnership_month_view (several authors) — surgery on its 'declared'
--     entry, anchor asserted once: it now SUMS the month's rows (it read one)
--     and adds 'declared_clients' and 'pra_held'.
--
-- Asserted: Shafqat's holding falls by exactly 2,825,426 and its ledger agrees;
-- the Popular rows total 2,088,624 and every line splits exactly; the declared
-- rows are 0 for September and 613,356 for October with 32,601 PRA; and
-- October's partnership carries Lahore at 613,356.

-- ── a declared profit can be per client, and carries the PRA held ───────────
alter table public.region_declared_profit
  add column if not exists client_id uuid references public.clients(id),
  add column if not exists pra_held numeric not null default 0 check (pra_held >= 0);
comment on column public.region_declared_profit.client_id is
  '0573: the client this declared profit is for. Null = the region''s whole month. A month is declared one way or the other, never both.';
comment on column public.region_declared_profit.pra_held is
  '0573: PRA withheld by GGS from the regional partner, to be paid by head office — shown beside the profit as "kept by GGS incl. PRA" (DECIDED 28 Oct 2026).';
alter table public.region_declared_profit drop constraint if exists region_declared_profit_branch_id_period_month_key;
drop index if exists public.region_declared_profit_one_row;
create unique index region_declared_profit_one_row
  on public.region_declared_profit (branch_id, period_month, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

do $restate$
begin
  if to_regprocedure('public.declare_region_profit(uuid, date, numeric, text)') is null then return; end if;  -- replay
  if md5(pg_get_functiondef('public.declare_region_profit(uuid, date, numeric, text)'::regprocedure)) <> '59bb380cff53ac858493935b4f179aa7' then
    raise exception '0573 REFUSED: declare_region_profit is not the body 0537 wrote; an unrecorded edit would be lost.';
  end if;
  drop function public.declare_region_profit(uuid, date, numeric, text);
end $restate$;

create or replace function public.declare_region_profit(
  p_branch_id uuid, p_month date, p_amount numeric, p_note text default null,
  p_client_id uuid default null, p_pra_held numeric default 0)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_company uuid; v_m date := date_trunc('month', p_month)::date;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_branch_id via public.branches
  if p_branch_id is not null then perform public.assert_same_company((select company_id from public.branches where id = p_branch_id)); end if;
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  select company_id into v_company from public.branches where id = p_branch_id;
  if v_company is null then raise exception 'Choose the region. Nothing has been recorded.'; end if;
  if p_amount is null then raise exception 'Enter the profit for the month. Nothing has been recorded.'; end if;
  if coalesce(p_pra_held, 0) < 0 then raise exception 'The PRA held cannot be below zero. Nothing has been recorded.'; end if;
  if p_client_id is not null and not exists (select 1 from public.clients c where c.id = p_client_id and c.branch_id = p_branch_id) then
    raise exception 'That client is not in this region. Nothing has been recorded.';
  end if;
  if not public.region_outside_partnership(p_branch_id, v_m) then
    raise exception 'This region is inside the partnership for %, so its profit is computed, not declared. Nothing has been recorded.', to_char(v_m, 'Mon YYYY');
  end if;
  if exists (select 1 from public.profit_allocation_runs r where r.company_id = v_company and r.period_month = v_m and r.status = 'POSTED') then
    raise exception 'The partnership run for % is posted. Reverse it first. Nothing has been recorded.', to_char(v_m, 'Mon YYYY');
  end if;
  -- 0573: a month is declared as one figure or per client, never both — the
  -- partnership adds every row, so a mix would count the region twice.
  if exists (select 1 from public.region_declared_profit d
              where d.branch_id = p_branch_id and d.period_month = v_m
                and (d.client_id is null) <> (p_client_id is null)) then
    raise exception '% is already declared %. Declare the month one way only. Nothing has been recorded.',
      to_char(v_m, 'Mon YYYY'), case when p_client_id is null then 'per client' else 'as one figure' end;
  end if;
  insert into public.region_declared_profit (company_id, branch_id, period_month, amount, note, client_id, pra_held)
  values (v_company, p_branch_id, v_m, p_amount, nullif(btrim(p_note), ''), p_client_id, coalesce(p_pra_held, 0))
  on conflict (branch_id, period_month, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update
    set amount = excluded.amount, note = excluded.note, pra_held = excluded.pra_held, updated_by = auth.uid(), updated_at = now();
end $function$;
revoke all on function public.declare_region_profit(uuid, date, numeric, text, uuid, numeric) from public, anon;
grant execute on function public.declare_region_profit(uuid, date, numeric, text, uuid, numeric) to authenticated;

-- ── the month view sums the rows, and lists them ────────────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.partnership_month_view(uuid, date)'::regprocedure);
  v_anchor constant text := $a$'declared', (select d.amount from public.region_declared_profit d where d.branch_id = (e->>'branch_id')::uuid and d.period_month = v_m)$a$;
  v_n int;
begin
  if position('0573' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0573 REFUSED: the declared anchor appears % times in partnership_month_view.', v_n; end if;
  execute replace(v_def, v_anchor,
    $r$'declared', (select sum(d.amount) from public.region_declared_profit d where d.branch_id = (e->>'branch_id')::uuid and d.period_month = v_m), -- 0573: summed; per-client rows below
          'pra_held', (select sum(d.pra_held) from public.region_declared_profit d where d.branch_id = (e->>'branch_id')::uuid and d.period_month = v_m),
          'declared_clients', (select jsonb_agg(jsonb_build_object('client', c.name, 'amount', d.amount, 'pra_held', d.pra_held) order by d.amount desc)
                                 from public.region_declared_profit d join public.clients c on c.id = d.client_id
                                where d.branch_id = (e->>'branch_id')::uuid and d.period_month = v_m)$r$);
end $surgery$;

-- ── Shafqat's side of the statement, and the declared profit ────────────────
do $mig$
declare
  v_co     constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_br     constant uuid := 'a46fd702-8796-4858-b338-142628ce33cf';   -- Lahore
  v_loc    constant uuid := '36c4c1ee-9630-4919-8e8d-f425953ff984';   -- Shafqat Ali Raza's cash
  v_berger constant uuid := '9c0991ac-544a-4a62-ab28-69521e8b6165';
  v_pb     constant uuid := '4b15d7b1-df5c-4f8d-b66a-c932ca6eae50';
  v_pwt    constant uuid := 'f2217757-1806-440e-a8d2-defd5511e9ba';
  v_ws     constant uuid := 'af9fb3a1-64c3-457d-a073-706c5034654c';
  v_ar     constant uuid := '11b2c992-88e2-463a-b9ba-5e777c173043';
  -- revenue weights (Jun–Sep invoices on the statement), for the costs
  v_clients constant jsonb := '[
    {"id": "4b15d7b1-df5c-4f8d-b66a-c932ca6eae50", "w": 451468},
    {"id": "f2217757-1806-440e-a8d2-defd5511e9ba", "w": 440708},
    {"id": "af9fb3a1-64c3-457d-a073-706c5034654c", "w": 942051},
    {"id": "11b2c992-88e2-463a-b9ba-5e777c173043", "w": 908971}]';
  v_wsum constant numeric := 2743198;
  v_cat_share uuid;
  v_before numeric; v_after numeric; v_glgap numeric; v_total numeric; v_id uuid;
  ln record; cl record; v_left numeric; v_n int;
begin
  if exists (select 1 from public.expenses where company_id = v_co and description like '0573:%') then
    return;  -- replay
  end if;
  if exists (select 1 from public.region_declared_profit where branch_id = v_br and period_month in ('2026-09-01', '2026-10-01')) then
    raise exception '0573 REFUSED: a Lahore profit is already declared for September or October.';
  end if;
  if (select count(*) from public.clients c where c.id in (v_berger, v_pb, v_pwt, v_ws, v_ar) and c.branch_id = v_br and c.company_id = v_co) <> 5 then
    raise exception '0573 REFUSED: Berger and the four Popular-group clients are not all Lahore clients of this company.';
  end if;

  select operational into v_before from public.custodian_held_operational(v_co) where cash_location_id = v_loc;

  select id into v_cat_share from public.expense_categories where company_id = v_co and name = 'Lahore partner share';
  if v_cat_share is null then
    insert into public.expense_categories (company_id, name) values (v_co, 'Lahore partner share') returning id into v_cat_share;
  end if;

  -- one expense from Shafqat's holding, as record_expense writes a cash expense
  create temp table _x (cat text, client uuid, amount numeric, descr text, d date) on commit drop;

  -- Berger
  insert into _x values
    ('Lahore partner share',   v_berger,  58699, '45% profit share, Maj Shafqat (Berger, August)', '2026-10-09'),
    ('Payroll/Salary Expense', v_berger, 464000, 'Salaries, September: (9) 270,000 · (2) 64,000 · (2) 80,000 · special guards (2) 50,000', '2026-10-21'),
    ('Utilities & Rent',       v_berger,   8000, 'Rent, September', '2026-10-21'),
    ('Utilities & Rent',       v_berger,   8010, 'Electricity, September', '2026-10-21'),
    ('Transportation & Fuel',  v_berger,    700, 'Transportation, September', '2026-10-21'),
    ('Lahore partner share',   v_berger, 103000, 'Share paid to Maj Khalid (Berger, September)', '2026-10-21'),
    ('Lahore partner share',   v_berger,  94393, '45% profit share, Maj Shafqat (Berger, September)', '2026-10-21');

  -- Popular: each cost line divided across the four clients by revenue,
  -- largest remainder so the parts add to the line exactly
  for ln in
    select * from (values
      ('Payroll/Salary Expense', 1557580::numeric, 'Salaries Jun–Sep (Shafqat''s Popular statement)'),
      ('Weapons & Ammunition',     98000::numeric, 'Weapons (7)'),
      ('Equipment & Supplies',     19000::numeric, 'Metal detector'),
      ('Uniform',                   5700::numeric, 'Uniforms (3) 3,900 and shoes (2) 1,800'),
      ('Transportation & Fuel',     9000::numeric, 'Transportation'),
      ('Miscellaneous',            14000::numeric, 'Welfare — a guard''s hospital expenses'),
      ('Transportation & Fuel',     1900::numeric, 'APSA Uber charges'),
      ('Licenses',                 14700::numeric, 'APSA fee'),
      ('GIFT',                     20000::numeric, 'Goodwill gesture paid to Sub sb')
    ) as t(cat, amount, descr)
  loop
    v_left := ln.amount;
    for cl in
      with s as (
        select (j->>'id')::uuid id, ln.amount * (j->>'w')::numeric / v_wsum exact from jsonb_array_elements(v_clients) j
      ), f as (
        select id, floor(exact) base, exact - floor(exact) frac from s
      ), r as (
        select id, base, row_number() over (order by frac desc, id) rk from f
      )
      select r.id, r.base + case when r.rk <= (ln.amount - (select sum(base) from f)) then 1 else 0 end as amt from r
    loop
      insert into _x values (ln.cat, cl.id, cl.amt, ln.descr, '2026-10-21');
      v_left := v_left - cl.amt;
    end loop;
    if v_left <> 0 then raise exception '0573 REFUSED: line "%" split leaves %.', ln.descr, v_left; end if;
  end loop;
  -- Popular: Shafqat's 45%, each client's from its own profit
  insert into _x values
    ('Lahore partner share', v_pb,   56908, '45% profit share, Maj Shafqat (Popular, Jun–Sep)', '2026-10-21'),
    ('Lahore partner share', v_pwt,  56321, '45% profit share, Maj Shafqat (Popular, Jun–Sep)', '2026-10-21'),
    ('Lahore partner share', v_ws,  119396, '45% profit share, Maj Shafqat (Popular, Jun–Sep)', '2026-10-21'),
    ('Lahore partner share', v_ar,  116119, '45% profit share, Maj Shafqat (Popular, Jun–Sep)', '2026-10-21');

  for ln in select * from _x loop
    insert into public.expenses (
      company_id, category_id, pl_category, client_id, branch_id, description,
      amount, expense_date, payment_mode, custodian_location_id)
    values (
      v_co, (select id from public.expense_categories where company_id = v_co and name = ln.cat),
      'cost_of_services'::public.expense_pl_category, ln.client, v_br, '0573: ' || ln.descr,
      ln.amount, ln.d, 'Cash', v_loc)
    returning id into v_id;
    if (select category_id from public.expenses where id = v_id) is null then
      raise exception '0573 REFUSED: no expense category "%".', ln.cat;
    end if;
    perform public.apply_money_delta(v_co, 'Cash', null, -ln.amount, 'expense',
      public.describe_expense((select category_id from public.expenses where id = v_id), ln.client, '0573: ' || ln.descr), v_id::text);
  end loop;

  -- the declared profit: September nothing; October per client
  insert into public.region_declared_profit (company_id, branch_id, period_month, amount, note, client_id, pra_held) values
    (v_co, v_br, '2026-09-01', 0, '0573: Lahore received nothing in September (Berger 6 Oct, Popular 21 Oct).', null, 0),
    (v_co, v_br, '2026-10-01', 187113, '0573: GGS 55% — Berger August 71,743 + September 115,370, received 6 and 21 Oct.', v_berger, 6912),
    (v_co, v_br, '2026-10-01',  69554, '0573: GGS 55% — Popular Jun–Sep, received 21 Oct.', v_pb,  4292),
    (v_co, v_br, '2026-10-01',  68837, '0573: GGS 55% — Popular Jun–Sep, received 21 Oct.', v_pwt, 4143),
    (v_co, v_br, '2026-10-01', 145929, '0573: GGS 55% — Popular Jun–Sep, received 21 Oct.', v_ws,  8627),
    (v_co, v_br, '2026-10-01', 141923, '0573: GGS 55% — Popular Jun–Sep, received 21 Oct.', v_ar,  8627);

  -- ── asserts ─────────────────────────────────────────────────────────────────
  select coalesce(sum(amount), 0) into v_total from public.expenses
   where company_id = v_co and description like '0573:%' and client_id in (v_pb, v_pwt, v_ws, v_ar);
  if v_total <> 2088624 then raise exception '0573 REFUSED: Popular''s rows total %, not 2,088,624.', v_total; end if;
  select coalesce(sum(amount), 0) into v_total from public.expenses
   where company_id = v_co and description like '0573:%' and client_id = v_berger;
  if v_total <> 736802 then raise exception '0573 REFUSED: Berger''s rows total %, not 736,802 (58,699 + 678,103).', v_total; end if;

  select operational, difference into v_after, v_glgap from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  if abs((v_before - v_after) - 2825426) > 0.005 then
    raise exception '0573 REFUSED: Shafqat''s holding fell by %, expected 2,825,426.', v_before - v_after;
  end if;
  if abs(v_glgap) > 0.005 then
    raise exception '0573 REFUSED: Shafqat''s holding and its ledger disagree by %.', v_glgap;
  end if;

  if (select sum(amount) from public.region_declared_profit where branch_id = v_br and period_month = '2026-10-01') <> 613356
     or (select sum(pra_held) from public.region_declared_profit where branch_id = v_br and period_month = '2026-10-01') <> 32601
     or (select sum(amount) from public.region_declared_profit where branch_id = v_br and period_month = '2026-09-01') <> 0 then
    raise exception '0573 REFUSED: the declared figures are not 0 (Sep) and 613,356 with PRA 32,601 (Oct).';
  end if;
  if (select amount from public.partnership_allocation('2026-10-01', '2026-10-31', 'cash', v_co)
       where row_kind = 'EQUITY_REGION' and branch_id = v_br) <> 613356 then
    raise exception '0573 REFUSED: October''s partnership does not carry Lahore at 613,356.';
  end if;
end $mig$;

do $$
begin
  if exists (select 1 from public.tenant_guard_gaps()) then
    raise exception '0573 REFUSED: tenant_guard_gaps() reports a gap.';
  end if;
end $$;
