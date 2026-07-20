-- Assets & Inventory extension (spec section 20).
--
-- Broadens inventory beyond weapons/uniforms (equipment, site assets), adds a
-- vehicle register with a fuel/maintenance log and monthly cost, ammunition
-- accounting per weapon (issued vs accounted, discrepancy is a blocking-tier
-- signal), wires unreturned kit into the exit clearance as a deduction, and
-- adds reorder levels + item value for central stock control.

-- ===========================================================================
-- 1. Inventory: new kinds, recover-on-contract-end, reorder level, value.
-- ===========================================================================

alter table public.inventory_items drop constraint if exists inventory_items_kind_check;
alter table public.inventory_items add constraint inventory_items_kind_check
  check (kind = any (array['weapon', 'uniform', 'equipment', 'site_asset']));

alter table public.inventory_items
  add column if not exists recover_on_contract_end boolean not null default false,
  add column if not exists reorder_level integer not null default 0,
  add column if not exists unit_value numeric(16,2) not null default 0,
  -- Site assets deployed to a client are recovered when that contract ends.
  add column if not exists deployed_client_id uuid references public.clients(id);

-- Central stock below its reorder level (a dashboard/warning signal).
create or replace view public.low_stock_items
  with (security_invoker = true) as
  select ii.company_id, ii.branch_id, ii.id as item_id, ii.kind, ii.item_type,
         ii.quantity, ii.reorder_level,
         b.name as region_name
    from public.inventory_items ii
    left join public.branches b on b.id = ii.branch_id
   where ii.reorder_level > 0 and ii.quantity <= ii.reorder_level;

-- ===========================================================================
-- 2. Vehicles & fuel/maintenance log -> monthly cost per vehicle.
-- ===========================================================================

create table if not exists public.vehicles (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  branch_id          uuid references public.branches(id),
  registration_no    text not null,
  make               text,
  model              text,
  model_year         integer,
  assigned_employee_id uuid references public.employees(id),
  fixed_asset_id     uuid references public.fixed_assets(id),  -- link to §4.1 capitalisation
  active             boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, registration_no)
);

do $$ begin
  create type public.vehicle_log_type as enum ('trip', 'fuel', 'maintenance');
exception when duplicate_object then null; end $$;

create table if not exists public.vehicle_logs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  vehicle_id    uuid not null references public.vehicles(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  log_type      public.vehicle_log_type not null,
  log_date      date not null default current_date,
  odometer      integer,
  litres        numeric(10,2),
  amount        numeric(16,2) not null default 0,
  description   text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);

create index if not exists idx_vlog_vehicle on public.vehicle_logs(vehicle_id, log_date);
create index if not exists idx_vlog_company on public.vehicle_logs(company_id, log_date);

-- Monthly cost per vehicle, region-inherited (fuel + maintenance).
create or replace view public.vehicle_monthly_cost
  with (security_invoker = true) as
  select v.company_id,
         v.id as vehicle_id,
         v.registration_no,
         v.branch_id,
         b.name as region_name,
         date_trunc('month', l.log_date)::date as period_month,
         sum(l.amount) filter (where l.log_type = 'fuel')        as fuel_cost,
         sum(l.amount) filter (where l.log_type = 'maintenance') as maintenance_cost,
         sum(l.amount)                                            as total_cost
    from public.vehicles v
    join public.vehicle_logs l on l.vehicle_id = v.id
    left join public.branches b on b.id = v.branch_id
   group by v.company_id, v.id, v.registration_no, v.branch_id, b.name,
            date_trunc('month', l.log_date);

-- ===========================================================================
-- 3. Ammunition accounting per weapon.
-- ===========================================================================

create table if not exists public.ammunition_counts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  weapon_item_id  uuid not null references public.inventory_items(id) on delete cascade,
  branch_id       uuid references public.branches(id),
  count_date      date not null default current_date,
  issued_rounds   integer not null default 0,
  accounted_rounds integer not null default 0,  -- fired-with-evidence + returned
  -- Positive discrepancy = rounds unaccounted for (the dangerous case).
  discrepancy     integer generated always as (issued_rounds - accounted_rounds) stored,
  notes           text,
  resolved        boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

create index if not exists idx_ammo_company on public.ammunition_counts(company_id, count_date);
create index if not exists idx_ammo_weapon on public.ammunition_counts(weapon_item_id);

-- Open discrepancies — the source the §21 blocking alert reads.
create or replace view public.ammunition_discrepancies
  with (security_invoker = true) as
  select ac.company_id, ac.branch_id, ac.id as count_id, ac.weapon_item_id,
         ii.item_type, ii.serial_number,
         ac.count_date, ac.issued_rounds, ac.accounted_rounds, ac.discrepancy,
         b.name as region_name
    from public.ammunition_counts ac
    join public.inventory_items ii on ii.id = ac.weapon_item_id
    left join public.branches b on b.id = ac.branch_id
   where ac.discrepancy <> 0 and not ac.resolved;

-- ===========================================================================
-- 4. Plumbing: company autofill, RLS, region inheritance.
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array['vehicles', 'vehicle_logs', 'ammunition_counts'] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$s', t);
    execute format('create trigger trg_aaa_%1$s_fill_company before insert on public.%1$s
                      for each row execute function public.fill_company_id()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%1$s', t);
    execute format('create policy "ssa_all" on public.%1$s for all
                      using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%1$s', t);
    execute format('create policy "company_members" on public.%1$s for all
                      using (company_id = public.current_company_id())
                      with check (company_id = public.current_company_id())', t);
  end loop;
end$$;

-- Vehicle logs inherit the vehicle's region; ammo counts inherit the weapon's.
create or replace function public.inherit_region_vehicle_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id,
    (select branch_id from public.vehicles where id = new.vehicle_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_vlog_region on public.vehicle_logs;
create trigger trg_bbb_vlog_region
  before insert or update of vehicle_id, company_id on public.vehicle_logs
  for each row execute function public.inherit_region_vehicle_log();

create or replace function public.inherit_region_ammo()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id,
    (select branch_id from public.inventory_items where id = new.weapon_item_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_ammo_region on public.ammunition_counts;
create trigger trg_bbb_ammo_region
  before insert or update of weapon_item_id, company_id on public.ammunition_counts
  for each row execute function public.inherit_region_ammo();

create or replace function public.inherit_region_vehicle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id,
    public.region_for_employee(new.assigned_employee_id),
    public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_vehicle_region on public.vehicles;
create trigger trg_bbb_vehicle_region
  before insert or update of assigned_employee_id, company_id on public.vehicles
  for each row execute function public.inherit_region_vehicle();

-- ===========================================================================
-- 5. Kit-return gates clearance: unreturned kit deducts from final dues.
--    Extends §12's assess_clearance to value the outstanding kit.
-- ===========================================================================

alter table public.clearance_certificates
  add column if not exists outstanding_kit_value numeric(16,2);

create or replace function public.assess_clearance(p_employee_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g         record;
  v_id      uuid;
  v_ok      boolean;
  v_company uuid;
  v_kit_value numeric;
begin
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  select * into g from public.employee_clearance_gates(p_employee_id);

  -- Value of kit issued and not yet returned (deducts from final dues).
  select coalesce(sum(coalesce(ii.unit_value, 0)), 0) into v_kit_value
    from public.issuances i
    join public.inventory_items ii on ii.id = i.item_id
   where i.employee_id = p_employee_id and i.return_date is null;

  v_ok := g.outstanding_kit_count = 0 and g.outstanding_advance <= 0 and g.open_incident_count = 0;

  select id into v_id from public.clearance_certificates
   where employee_id = p_employee_id and not dues_released
   order by created_at desc limit 1;

  if v_id is null then
    insert into public.clearance_certificates (company_id, employee_id)
    values (v_company, p_employee_id) returning id into v_id;
  end if;

  update public.clearance_certificates set
    kit_returned          = (g.outstanding_kit_count = 0),
    outstanding_kit_count = g.outstanding_kit_count,
    outstanding_kit_value = v_kit_value,
    advance_settled       = (g.outstanding_advance <= 0),
    outstanding_advance   = g.outstanding_advance,
    incidents_reviewed    = (g.open_incident_count = 0),
    open_incident_count   = g.open_incident_count,
    status                = (case when v_ok then 'cleared' else 'blocked' end)::public.clearance_status,
    cleared_by            = case when v_ok then auth.uid() else cleared_by end,
    updated_at            = now()
  where id = v_id;

  return v_id;
end;
$$;
