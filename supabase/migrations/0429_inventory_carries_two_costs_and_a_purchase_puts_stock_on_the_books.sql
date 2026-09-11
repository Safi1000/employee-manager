-- 0429 — inventory carries two costs, and a purchase puts stock on the books.
--
-- WHAT WAS THERE. `inventory_items` held one row per thing with a single
-- `unit_value`, a free-text `item_type`, and no catalogue behind it. `issuances`
-- held an issue and an optional `return_date`. Both are EMPTY on production —
-- zero rows — and nothing has ever been purchased into them, so there is no
-- migration of data to do and no user to disturb. They are replaced rather than
-- extended, because two of the things this spec needs cannot be added to them:
--
--   * TWO COSTS. Actual (what was paid, the ledger figure, reduced by a bulk
--     discount) and replacement (what one costs to replace, NOT reduced by a
--     discount, and what fines are computed from). One `unit_value` cannot be
--     both, and collapsing them makes every fine wrong by the discount.
--   * A CATALOGUE. "Is this issuable", "how long does it last", "what does one
--     cost to replace" are properties of the TYPE, set once. On a free-text
--     column they are properties of nothing.
--
-- THE TEST FOR WHAT IS TRACKED IS THE ITEM TYPE, AND THERE IS NO VALUE
-- THRESHOLD. A threshold on the purchase would mean three uniforms skip
-- inventory while two hundred do not, and the stock count is then wrong the
-- moment somebody buys a few. `issuable` is set once on the type and decides.

-- ---------------------------------------------------------------------------
-- 1. THE CATALOGUE
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'item_category') then
    create type public.item_category as enum
      ('uniform', 'kit', 'ammunition', 'weapon', 'vehicle', 'office');
  end if;
  if not exists (select 1 from pg_type where typname = 'stock_grade') then
    create type public.stock_grade as enum ('new', 'used');
  end if;
end $$;

create table if not exists public.inventory_item_types (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  name                text not null,
  category            public.item_category not null,

  -- ISSUABLE IS THE WHOLE TEST. True → it is stock and every movement is
  -- tracked. False → it is an office expense and never touches inventory:
  -- stationery, tea, printer paper. Nothing about the amount enters into it.
  issuable            boolean not null default true,

  -- THE TWO COSTS, AND THEY ANSWER DIFFERENT QUESTIONS.
  --   actual      — moving average of what was actually PAID, maintained by
  --                 purchases. This is the ledger figure; inventory on the
  --                 balance sheet carries it, so the books balance against cash
  --                 spent. A bulk discount reduces it.
  --   replacement — what ONE costs to replace, set by hand. A bulk discount
  --                 does NOT reduce it. Fines and operational value read this.
  -- Collapsing them would fine a guard the discounted price of a uniform the
  -- company must now buy at full price to replace.
  actual_cost         numeric(14,2) not null default 0,
  replacement_cost    numeric(14,2) not null default 0,

  useful_life_months  integer not null default 12,

  -- STOCK SHAPE. `sized` splits stock by size (uniforms, boots); `serialised`
  -- gives every unit its own row, its own licence and its own expiry (weapons,
  -- vehicles). Ammunition is neither — it is a count.
  sized               boolean not null default false,
  serialised          boolean not null default false,

  -- Which inventory account this type's value sits in. Resolved through
  -- chart_of_accounts.system_key so the account can be renumbered without
  -- touching stock.
  inventory_key       text not null default 'inventory_kit',

  active              boolean not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint inventory_item_types_name_uniq unique (company_id, name),
  constraint inventory_item_types_costs_nonneg
    check (actual_cost >= 0 and replacement_cost >= 0),
  constraint inventory_item_types_life_positive check (useful_life_months > 0),
  -- An office-expense type is not stock, so it cannot be sized, serialised or
  -- carry an inventory account. Saying so here stops the contradiction being
  -- typed at all rather than discovered at posting time.
  constraint inventory_item_types_office_is_not_stock
    check (issuable or (not sized and not serialised)),
  -- A thing cannot be both a pool and a set of individuals.
  constraint inventory_item_types_one_shape check (not (sized and serialised))
);

comment on table public.inventory_item_types is
  '0429: the item catalogue. TWO COSTS per type — actual (paid, moving average, the ledger figure, reduced by a bulk discount) and replacement (what one costs to replace, not reduced, what fines read). `issuable` is the only test for whether something is tracked: there is no value threshold, because a threshold would let three uniforms skip inventory while two hundred did not.';

-- ---------------------------------------------------------------------------
-- 2. THE STOCK
--
-- ONE TABLE, NOT TWO. A pooled line (uniform, size L, used) and an individual
-- (this weapon, serial 1234) differ only in whether `serial_number` is set, and
-- unifying them means ONE issuance path instead of two that must agree.
-- quantity is 1 for anything serialised, enforced below.
--
-- QUANTITY IS WHAT IS IN THE STORE. Issued stock is not here — it is derived
-- from the movement log (0430). Nothing holds a second copy of the count.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_stock (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  item_type_id      uuid not null references public.inventory_item_types(id) on delete restrict,
  branch_id         uuid references public.branches(id),

  size              text,
  -- NEW AND USED ARE SEPARATE STOCK OF THE SAME ITEM. A used uniform is worth
  -- half a new one and is issued as a different thing.
  grade             public.stock_grade not null default 'new',

  serial_number     text,
  licence_expiry    date,

  quantity          integer not null default 0,

  -- The moving average of what this line actually cost. Weighted on every
  -- purchase; NOT touched by replacement cost.
  unit_actual_cost  numeric(14,2) not null default 0,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint inventory_stock_qty_nonneg check (quantity >= 0),
  constraint inventory_stock_cost_nonneg check (unit_actual_cost >= 0),
  constraint inventory_stock_serial_is_one check (serial_number is null or quantity <= 1)
);

-- A serial is unique within a company or it is not a serial.
create unique index if not exists inventory_stock_serial_uniq
  on public.inventory_stock (company_id, serial_number)
  where serial_number is not null;

-- One pooled line per (type, size, grade). Without this the same stock splits
-- across rows and the count is a sum nobody computes.
create unique index if not exists inventory_stock_pool_uniq
  on public.inventory_stock (company_id, item_type_id, coalesce(size, ''), grade)
  where serial_number is null;

comment on table public.inventory_stock is
  '0429: what is in the store. One row per pooled (type, size, grade) or per serialised unit. quantity is STOCK ON HAND — issued kit is not here, it is derived from kit_events (0430), so the count exists once. unit_actual_cost is the moving average of what was paid and is the value inventory carries on the balance sheet.';

-- ---------------------------------------------------------------------------
-- 3. THE ACCOUNTS
--
-- 1200 Inventory — Weapons and 1210 Inventory — Uniforms already exist on every
-- company. Ammunition and general kit did not, and a write-off/recovery account
-- did not. The 12xx band is denser than it looks — 1300 is already
-- Inter-Region Receivable — so the range was read before being added to (0347's
-- lesson, learned by a rolled-back migration).
-- ---------------------------------------------------------------------------
create or replace function public.ensure_inventory_accounts(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  r record;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  for r in
    select * from (values
      ('1220', 'Inventory — Ammunition',        'asset',   'debit',  'inventory_ammunition'),
      ('1230', 'Inventory — Kit & Equipment',   'asset',   'debit',  'inventory_kit'),
      ('1240', 'Inventory — Vehicles (unissued)','asset',  'debit',  'inventory_vehicles'),
      ('5310', 'Kit Recovered from Guards',     'expense', 'debit',  'kit_recovered'),
      ('5320', 'Unrecovered Kit Fines',         'expense', 'debit',  'kit_fines_written_off')
    ) v(code, nm, atype, side, key)
  loop
    if not exists (select 1 from public.chart_of_accounts a
                    where a.company_id = p_company_id and a.system_key = r.key) then
      insert into public.chart_of_accounts
        (company_id, account_code, account_name, account_type, normal_side,
         system_key, active, system_account, is_control)
      values (p_company_id, r.code, r.nm, r.atype::account_type, r.side::account_normal_side,
              r.key, true, true, false);
    end if;
  end loop;
end;
$fn$;

comment on function public.ensure_inventory_accounts(uuid) is
  '0429: the inventory accounts a company needs, created lazily like ensure_prepaid_expenses_account so a company added later gets them on first use. 1200/1210 predate this and are left alone. kit_recovered (5310) is a CONTRA cost — used kit coming back reduces cost at company level and never retroactively credits the client that consumed it.';

revoke execute on function public.ensure_inventory_accounts(uuid) from anon, public;
grant  execute on function public.ensure_inventory_accounts(uuid) to authenticated, service_role;

-- Backfill every company that exists now. Direct insert: the migration runs as
-- postgres and has no tenant claim for assert_same_company to check.
insert into public.chart_of_accounts
  (company_id, account_code, account_name, account_type, normal_side,
   system_key, active, system_account, is_control)
select c.id, v.code, v.nm, v.atype::account_type, v.side::account_normal_side, v.key, true, true, false
  from public.companies c
  cross join (values
    ('1220', 'Inventory — Ammunition',         'asset',   'debit',  'inventory_ammunition'),
    ('1230', 'Inventory — Kit & Equipment',    'asset',   'debit',  'inventory_kit'),
    ('1240', 'Inventory — Vehicles (unissued)','asset',   'debit',  'inventory_vehicles'),
    ('5310', 'Kit Recovered from Guards',      'expense', 'debit',  'kit_recovered'),
    ('5320', 'Unrecovered Kit Fines',          'expense', 'debit',  'kit_fines_written_off')
  ) v(code, nm, atype, side, key)
 where not exists (
   select 1 from public.chart_of_accounts a
    where a.company_id = c.id and a.system_key = v.key);

-- ---------------------------------------------------------------------------
-- 4. PURCHASING — the path from spending money to holding stock.
--
-- There was none. Buying two hundred uniforms was an expense, so the P&L took
-- the whole cost in one month and the store held nothing the system knew about.
--
--   CONSUMABLES (uniform, kit, ammunition) — capitalised into inventory at
--   ACTUAL cost. Dr Inventory / Cr Cash|Bank|Payable. The P&L is untouched
--   until the kit is issued (0431).
--
--   ASSETS (weapon, vehicle) — capitalised individually into fixed_assets and
--   depreciated over their life. That machinery already exists (run_depreciation)
--   and is reused rather than rebuilt.
--
--   OFFICE — never inventory. Refused here, because an office type has no
--   inventory account and posting one would put tea on the balance sheet.
--
-- THE OPERATOR CHOOSES THE ITEM, NOT THE TREATMENT. The type decides.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_purchases (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  branch_id        uuid references public.branches(id),
  purchase_date    date not null,
  vendor_id        uuid references public.vendors(id),
  payment_mode     text not null default 'Payable',
  bank_account_id  uuid references public.bank_accounts(id),
  custodian_location_id uuid references public.cash_locations(id),
  description      text,
  total_actual     numeric(14,2) not null default 0,
  posted_at        timestamptz,
  journal_entry_id uuid,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  constraint inventory_purchases_mode
    check (payment_mode in ('Cash', 'Bank', 'Cheque', 'Payable')),
  constraint inventory_purchases_total_nonneg check (total_actual >= 0)
);

create table if not exists public.inventory_purchase_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  purchase_id    uuid not null references public.inventory_purchases(id) on delete cascade,
  item_type_id   uuid not null references public.inventory_item_types(id) on delete restrict,
  size           text,
  grade          public.stock_grade not null default 'new',
  serial_number  text,
  licence_expiry date,
  quantity       integer not null,
  -- THE LINE'S OWN ACTUAL COST PER UNIT — after any bulk discount. This is what
  -- reaches the ledger and the moving average. replacement_cost on the type is
  -- deliberately NOT touched by a purchase: a discount is a fact about this
  -- purchase, not about what a replacement costs.
  unit_actual_cost numeric(14,2) not null,
  created_at     timestamptz not null default now(),
  constraint inventory_purchase_lines_qty_positive check (quantity > 0),
  constraint inventory_purchase_lines_cost_nonneg check (unit_actual_cost >= 0),
  constraint inventory_purchase_lines_serial_is_one
    check (serial_number is null or quantity = 1)
);

create index if not exists inventory_purchase_lines_purchase_idx
  on public.inventory_purchase_lines (purchase_id);
create index if not exists inventory_stock_type_idx
  on public.inventory_stock (company_id, item_type_id);

comment on table public.inventory_purchases is
  '0429: a purchase of stock. Capitalises — Dr Inventory, Cr Cash/Bank/Payable — so buying 200 uniforms does not touch the P&L. The cost reaches the P&L when the kit is ISSUED, on the client it was issued to (0431).';

-- ---------------------------------------------------------------------------
-- 5. RLS. Company-scoped read, inventory.edit to write — the same shape as
--    every other operational table here.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['inventory_item_types', 'inventory_stock',
                           'inventory_purchases', 'inventory_purchase_lines']
  loop
    execute format('alter table public.%I enable row level security', t);

    execute format($p$drop policy if exists company_members on public.%I$p$, t);
    execute format($p$create policy company_members on public.%I for all to public
                      using (company_id = public.current_company_id())
                      with check (company_id = public.current_company_id())$p$, t);

    execute format($p$drop policy if exists ssa_all on public.%I$p$, t);
    execute format($p$create policy ssa_all on public.%I for all to public
                      using (public.is_ssa_unscoped())
                      with check (public.is_ssa_unscoped())$p$, t);

    execute format($p$drop policy if exists perm_write_ins on public.%I$p$, t);
    execute format($p$create policy perm_write_ins on public.%I as restrictive
                      for insert to public with check (public.has_perm('inventory.edit'))$p$, t);

    execute format($p$drop policy if exists perm_write_upd on public.%I$p$, t);
    execute format($p$create policy perm_write_upd on public.%I as restrictive
                      for update to public using (public.has_perm('inventory.edit'))
                      with check (public.has_perm('inventory.edit'))$p$, t);

    execute format($p$drop policy if exists perm_write_del on public.%I$p$, t);
    execute format($p$create policy perm_write_del on public.%I as restrictive
                      for delete to public using (public.has_perm('inventory.edit'))$p$, t);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- company_id is filled from the caller's claim, like every other table here.
do $$
declare t text;
begin
  foreach t in array array['inventory_item_types', 'inventory_stock',
                           'inventory_purchases', 'inventory_purchase_lines']
  loop
    execute format('drop trigger if exists trg_aaa_%s_fill_company on public.%I', t, t);
    execute format('create trigger trg_aaa_%s_fill_company before insert on public.%I
                    for each row execute function public.fill_company_id()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. THE PURCHASE RPC. Stock in and the journal in ONE transaction.
--
-- Not three REST calls from a screen. A purchase that put stock on the shelf
-- and failed to post is a balance sheet that disagrees with the store, and the
-- expense defect this project spent a week on was exactly that shape.
-- ---------------------------------------------------------------------------
create or replace function public.record_inventory_purchase(
  p_purchase_date date,
  p_lines         jsonb,          -- [{item_type_id, size, grade, serial_number, licence_expiry, quantity, unit_actual_cost}]
  p_payment_mode  text default 'Payable',
  p_vendor_id     uuid default null,
  p_bank_account_id uuid default null,
  p_custodian_location_id uuid default null,
  p_branch_id     uuid default null,
  p_description   text default null)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_co        uuid;
  v_purchase  uuid;
  v_line      jsonb;
  v_type      public.inventory_item_types%rowtype;
  v_qty       int;
  v_unit      numeric;
  v_size      text;
  v_grade     public.stock_grade;
  v_serial    text;
  v_expiry    date;
  v_stock     uuid;
  v_old_qty   int;
  v_old_cost  numeric;
  v_total     numeric := 0;
  v_jlines    jsonb := '[]'::jsonb;
  v_credit    text;
  v_entry     uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;

  v_co := public.current_company_id();
  if v_co is null then raise exception 'No company in scope'; end if;
  perform public.ensure_inventory_accounts(v_co);

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'A purchase needs at least one line';
  end if;

  insert into public.inventory_purchases
    (company_id, branch_id, purchase_date, vendor_id, payment_mode,
     bank_account_id, custodian_location_id, description, created_by)
  values (v_co, p_branch_id, p_purchase_date, p_vendor_id, p_payment_mode,
          p_bank_account_id, p_custodian_location_id, p_description, auth.uid())
  returning id into v_purchase;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_type from public.inventory_item_types
     where id = (v_line->>'item_type_id')::uuid and company_id = v_co;
    if v_type.id is null then
      raise exception 'Unknown item type on a purchase line';
    end if;

    -- OFFICE NEVER BECOMES STOCK. Refused rather than quietly skipped: a line
    -- that silently vanished would leave the purchase total disagreeing with
    -- the sum of its lines, which is the kind of wrong that balances.
    if not v_type.issuable then
      raise exception
        'ITEM TYPE "%" IS NOT ISSUABLE, so it is an office expense and never touches inventory. Record it on the Expenses screen instead.',
        v_type.name;
    end if;

    v_qty   := (v_line->>'quantity')::int;
    v_unit  := (v_line->>'unit_actual_cost')::numeric;
    v_size  := nullif(v_line->>'size', '');
    v_grade := coalesce(nullif(v_line->>'grade', ''), 'new')::public.stock_grade;
    v_serial:= nullif(v_line->>'serial_number', '');
    v_expiry:= nullif(v_line->>'licence_expiry', '')::date;

    if v_type.serialised and v_serial is null then
      raise exception '"%" is serialised — every unit needs its own serial number.', v_type.name;
    end if;
    if v_type.sized and v_size is null then
      raise exception '"%" is stocked by size — the line needs one.', v_type.name;
    end if;

    insert into public.inventory_purchase_lines
      (company_id, purchase_id, item_type_id, size, grade, serial_number,
       licence_expiry, quantity, unit_actual_cost)
    values (v_co, v_purchase, v_type.id, v_size, v_grade, v_serial,
            v_expiry, v_qty, v_unit);

    -- ---- stock in, at the MOVING AVERAGE of actual cost ----
    if v_serial is not null then
      insert into public.inventory_stock
        (company_id, item_type_id, branch_id, size, grade, serial_number,
         licence_expiry, quantity, unit_actual_cost)
      values (v_co, v_type.id, p_branch_id, v_size, v_grade, v_serial,
              v_expiry, v_qty, v_unit);
    else
      select id, quantity, unit_actual_cost into v_stock, v_old_qty, v_old_cost
        from public.inventory_stock
       where company_id = v_co and item_type_id = v_type.id
         and coalesce(size, '') = coalesce(v_size, '') and grade = v_grade
         and serial_number is null
       for update;

      if v_stock is null then
        insert into public.inventory_stock
          (company_id, item_type_id, branch_id, size, grade, quantity, unit_actual_cost)
        values (v_co, v_type.id, p_branch_id, v_size, v_grade, v_qty, v_unit);
      else
        -- WEIGHTED, not replaced. Two hundred at 1,200 then ten at 1,500 is not
        -- stock worth 1,500 each, and valuing it that way would put money on the
        -- balance sheet that never left the bank.
        update public.inventory_stock
           set quantity = v_old_qty + v_qty,
               unit_actual_cost = case when v_old_qty + v_qty = 0 then v_unit
                 else round((v_old_qty * v_old_cost + v_qty * v_unit) / (v_old_qty + v_qty), 2) end,
               updated_at = now()
         where id = v_stock;
      end if;
    end if;

    v_total := v_total + (v_qty * v_unit);

    -- One debit per line, on the type's own inventory account.
    v_jlines := v_jlines || jsonb_build_object(
      'key', v_type.inventory_key, 'debit', v_qty * v_unit, 'credit', 0);
  end loop;

  update public.inventory_purchases set total_actual = v_total where id = v_purchase;

  -- ---- the credit side: where the money came from ----
  v_credit := case p_payment_mode
    when 'Cash'    then 'cash'
    when 'Bank'    then 'bank'
    when 'Cheque'  then 'bank'
    else 'ap'
  end;
  v_jlines := v_jlines || jsonb_build_object('key', v_credit, 'debit', 0, 'credit', v_total);

  if v_total > 0 then
    v_entry := public.post_journal(
      v_co, p_purchase_date,
      coalesce(p_description, 'Inventory purchase'),
      'inventory_purchases', v_purchase, false, v_jlines, p_branch_id);
    update public.inventory_purchases
       set posted_at = now(), journal_entry_id = v_entry
     where id = v_purchase;

    -- MONEY MOVES IN ONE PLACE (0380). post_journal writes the LEDGER; the
    -- operational balance a screen shows is moved by apply_money_delta and by
    -- nothing else. Both, in this transaction, or the balance sheet and the
    -- cash box disagree the first time a purchase half-fails.
    --
    -- Cheque and Payable move nothing here on purpose: a cheque moves money
    -- when it clears and a payable when it is settled, which is
    -- apply_money_delta's own rule and not a second opinion about it.
    perform public.apply_money_delta(
      v_co, p_payment_mode, p_bank_account_id, -v_total,
      'inventory_purchase',
      coalesce(p_description, 'Inventory purchase'), v_purchase::text);
  end if;

  return v_purchase;
end;
$fn$;

comment on function public.record_inventory_purchase(date, jsonb, text, uuid, uuid, uuid, uuid, text) is
  '0429: a purchase of stock — rows, moving-average valuation and the journal in ONE transaction. Capitalises to inventory at ACTUAL cost, so the P&L is untouched until the kit is issued. Refuses a non-issuable (office) type rather than skipping the line, because a skipped line leaves the total disagreeing with the lines and that is the kind of wrong that balances.';

revoke execute on function public.record_inventory_purchase(date, jsonb, text, uuid, uuid, uuid, uuid, text) from anon, public;
grant  execute on function public.record_inventory_purchase(date, jsonb, text, uuid, uuid, uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Probe. Rollback only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co   uuid;
  v_t    uuid;
  v_qty  int;
  v_cost numeric;
  v_inv  numeric;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  if v_co is null then raise notice '0429: no company to probe; skipped.'; return; end if;

  begin
    insert into public.inventory_item_types
      (company_id, name, category, issuable, actual_cost, replacement_cost,
       useful_life_months, sized, inventory_key)
    values (v_co, '0429 probe uniform', 'uniform', true, 0, 2500, 12, true, 'inventory_uniforms')
    returning id into v_t;

    -- Two buys at different prices must weight, not overwrite.
    insert into public.inventory_stock
      (company_id, item_type_id, size, grade, quantity, unit_actual_cost)
    values (v_co, v_t, 'L', 'new', 200, 1200);

    update public.inventory_stock
       set quantity = 210,
           unit_actual_cost = round((200 * 1200 + 10 * 1500)::numeric / 210, 2)
     where company_id = v_co and item_type_id = v_t;

    select quantity, unit_actual_cost into v_qty, v_cost
      from public.inventory_stock where company_id = v_co and item_type_id = v_t;
    if v_qty <> 210 then
      raise exception '0429 FAILED: stock is % not 210.', v_qty;
    end if;
    if v_cost <> 1214.29 then
      raise exception '0429 FAILED: the moving average came out at % — 200@1200 + 10@1500 over 210 is 1214.29. Overwriting rather than weighting would say 1500 and put money on the balance sheet that never left the bank.', v_cost;
    end if;

    -- THE TWO COSTS DO NOT COLLAPSE. A bulk discount moved actual and must not
    -- have moved replacement — the fine is computed from the second.
    select replacement_cost into v_inv from public.inventory_item_types where id = v_t;
    if v_inv <> 2500 then
      raise exception '0429 FAILED: replacement cost moved with a purchase (% not 2500). A discount is a fact about that purchase, not about what a replacement costs.', v_inv;
    end if;

    -- The office rule is a constraint, not a convention.
    begin
      insert into public.inventory_item_types
        (company_id, name, category, issuable, sized, serialised)
      values (v_co, '0429 probe tea', 'office', false, true, false);
      raise exception '0429 FAILED: a non-issuable type was accepted as sized stock.';
    exception when check_violation then null;
    end;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0429: probe passed — weighted average, two costs kept apart, office refused as stock.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
--
-- ensure_inventory_accounts(p_company_id) is new and SECURITY DEFINER.
-- record_inventory_purchase is INVOKER and takes no company at all — it reads
-- current_company_id() — so it has no uuid parameter to guard.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;

  if v_n <> 0 then
    raise exception
      '0429 REFUSED: tenant_guard_gaps() reports % gap(s): %. Every uuid parameter that names a tenant-scoped row needs a guard the detector can see.',
      v_n, v_who;
  end if;
end $$;
