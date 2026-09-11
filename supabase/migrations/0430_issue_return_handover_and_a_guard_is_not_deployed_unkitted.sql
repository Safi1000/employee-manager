-- 0430 — issue, return, HANDOVER, and a guard is not deployed unkitted.
--
-- THE THIRD EVENT IS THE POINT. `issuances` had an issue row and a
-- `return_date`, which can express store→guard and guard→store and nothing
-- else. Guard→guard at the same site — the common case when one guard replaces
-- another — was unrepresentable, so it was recorded as a return plus a fresh
-- issue, and that is wrong twice: the kit never went near the store, and the
-- second issue charges the client again for kit it already paid for.
--
-- CONDITION TRAVELS WITH THE ITEM. Every event records the condition the item
-- is in. A guard receiving a handover at "rough" has that as his OPENING
-- condition and is judged only against the state he received it in. He is not
-- fined for wear that was already there — which is the whole reason the
-- received condition is stored on the event rather than recomputed later.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'kit_event_kind') then
    create type public.kit_event_kind as enum ('issue', 'return', 'handover');
  end if;
  if not exists (select 1 from pg_type where typname = 'kit_condition') then
    create type public.kit_condition as enum ('new', 'good', 'fair', 'rough', 'unusable');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. THE MOVEMENT LOG. Immutable; everything else is derived from it.
-- ---------------------------------------------------------------------------
create table if not exists public.kit_events (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  branch_id      uuid references public.branches(id),

  event          public.kit_event_kind not null,
  event_date     date not null default current_date,

  -- THE CHAIN. An issue is its own chain head; a return or handover names the
  -- issue it continues. Outstanding kit is issued minus returned PER CHAIN, so
  -- a handover moves a holding rather than opening a second one.
  issue_id       uuid references public.kit_events(id) on delete restrict,

  item_type_id   uuid not null references public.inventory_item_types(id) on delete restrict,
  size           text,
  grade          public.stock_grade not null default 'new',
  serial_number  text,
  quantity       integer not null default 1,

  from_employee_id uuid references public.employees(id),
  to_employee_id   uuid references public.employees(id),
  site_id          uuid references public.sites(id),

  -- THE CLIENT THE COST LANDS ON, carried from the holder's deployment at the
  -- moment of ISSUE and then frozen. A guard moving from Emaar to Nova in the
  -- same uniform leaves the cost with Emaar: Emaar consumed it.
  client_id      uuid references public.clients(id),

  -- `condition` is the state at this event. `received_condition` is the state
  -- the NEW holder is taking it on at, which is what a later fine is measured
  -- against. They are the same on a fresh issue and diverge on every handover.
  condition          public.kit_condition not null default 'new',
  received_condition public.kit_condition,

  -- What one unit was worth in inventory when it left the store. Snapshotted so
  -- the monthly cost entry cannot drift when the moving average moves later.
  unit_actual_cost numeric(14,2) not null default 0,

  -- Set by the monthly run once this issue's cost has been charged to a client,
  -- so it is charged exactly once.
  costed_month   date,

  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),

  -- ORDER WITHIN A DAY, AND WHY IT IS NOT A TIMESTAMP. The chain's latest event
  -- decides who holds the kit. created_at is now(), which is TRANSACTION time —
  -- two events written in one transaction carry the identical value, and an
  -- issue and a handover on the same day carry the same event_date. Ordering on
  -- either leaves the tie to the planner, and this migration's own probe caught
  -- it doing so: after a handover the view still reported the first guard.
  -- A sequence cannot tie.
  seq            bigint generated always as identity,

  constraint kit_events_qty_positive check (quantity > 0),
  -- WHO IS WHERE, per event kind. Written as a constraint because the three
  -- shapes are the thing this table exists to distinguish, and a handover with
  -- no `from` is a return wearing the wrong name.
  constraint kit_events_shape check (
    (event = 'issue'    and from_employee_id is null and (to_employee_id is not null or site_id is not null))
    or (event = 'return'   and from_employee_id is not null and to_employee_id is null)
    or (event = 'handover' and from_employee_id is not null and to_employee_id is not null)
  ),
  -- Only an issue may head its own chain.
  constraint kit_events_chain check (event = 'issue' or issue_id is not null)
);

create index if not exists kit_events_chain_idx on public.kit_events (issue_id);
create index if not exists kit_events_holder_idx on public.kit_events (company_id, to_employee_id);
create index if not exists kit_events_costing_idx
  on public.kit_events (company_id, event, costed_month) where event = 'issue';

comment on table public.kit_events is
  '0430: every kit movement — issue (store→guard or store→site), return (guard→store) and HANDOVER (guard→guard, same site, the kit never touches the store). Immutable log; holdings and outstanding kit are DERIVED from it and stored nowhere. A handover posts nothing: the client already absorbed the cost at first issue.';

-- ---------------------------------------------------------------------------
-- 2. WHO HOLDS WHAT, DERIVED.
--
-- No stored holding. The chain's latest event says who has it, and outstanding
-- quantity is issued minus returned on that chain — so a partial return is a
-- smaller number rather than a special case.
-- ---------------------------------------------------------------------------
create or replace view public.kit_holdings as
with chain as (
  select e.issue_id as chain_id,
         sum(case when e.event = 'return' then e.quantity else 0 end) as returned_qty
    from public.kit_events e
   where e.issue_id is not null and e.event = 'return'
   group by e.issue_id
),
latest as (
  select distinct on (coalesce(e.issue_id, e.id))
         coalesce(e.issue_id, e.id) as chain_id,
         e.event, e.to_employee_id, e.site_id, e.condition, e.received_condition,
         e.event_date
    from public.kit_events e
   order by coalesce(e.issue_id, e.id), e.event_date desc, e.seq desc
)
select i.id                          as issue_id,
       i.company_id,
       i.branch_id,
       i.item_type_id,
       i.size,
       i.grade,
       i.serial_number,
       i.client_id,
       i.site_id                     as issued_site_id,
       i.event_date                  as issued_on,
       i.unit_actual_cost,
       i.quantity                    as issued_qty,
       coalesce(c.returned_qty, 0)   as returned_qty,
       i.quantity - coalesce(c.returned_qty, 0) as outstanding_qty,
       l.to_employee_id              as holder_employee_id,
       l.site_id                     as holder_site_id,
       -- THE CONDITION HE TOOK IT ON AT. A fine is measured from here, never
       -- from 'new', or every handover would bill the last man for the wear of
       -- everybody before him.
       coalesce(l.received_condition, l.condition, i.condition) as opening_condition,
       l.event                       as last_event,
       l.event_date                  as last_event_date
  from public.kit_events i
  left join chain c on c.chain_id = i.id
  left join latest l on l.chain_id = i.id
 where i.event = 'issue'
   and i.quantity - coalesce(c.returned_qty, 0) > 0;

comment on view public.kit_holdings is
  '0430: open kit holdings, DERIVED from kit_events — never stored. One row per issue chain with the current holder, the outstanding quantity, and the condition that holder took it on at (which is what a clearance fine is measured against).';

grant select on public.kit_holdings to authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS + grants.
-- ---------------------------------------------------------------------------
alter table public.kit_events enable row level security;

drop policy if exists company_members on public.kit_events;
create policy company_members on public.kit_events for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

drop policy if exists ssa_all on public.kit_events;
create policy ssa_all on public.kit_events for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists perm_write_ins on public.kit_events;
create policy perm_write_ins on public.kit_events as restrictive
  for insert to public with check (public.has_perm('inventory.edit'));

drop policy if exists perm_write_upd on public.kit_events;
create policy perm_write_upd on public.kit_events as restrictive
  for update to public using (public.has_perm('inventory.edit'))
  with check (public.has_perm('inventory.edit'));

drop policy if exists perm_write_del on public.kit_events;
create policy perm_write_del on public.kit_events as restrictive
  for delete to public using (public.has_perm('inventory.edit'));

grant select, insert, update, delete on public.kit_events to authenticated;

drop trigger if exists trg_aaa_kit_events_fill_company on public.kit_events;
create trigger trg_aaa_kit_events_fill_company before insert on public.kit_events
  for each row execute function public.fill_company_id();

-- ---------------------------------------------------------------------------
-- 4. WHEN THE KIT RULE COMES INTO FORCE.
--
-- 323 guards are deployed today and nothing has ever been issued, because none
-- of this existed. A rule switched on now would refuse every deployment and a
-- check switched on now would be red on all 323 — and a control that is red on
-- arrival with no action available teaches people that red is normal.
--
-- So the rule has a DATE, and it is null until somebody sets it. Null means
-- "the store is not loaded yet": nothing is enforced and nothing is reported.
-- Setting it is the act of saying the opening stocktake is done.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_settings (
  company_id         uuid primary key references public.companies(id) on delete cascade,
  -- Deployments STARTING on or after this date require an open issuance.
  -- Null = not in force. DEFERRED until the opening stocktake is entered.
  kit_required_from  date,
  -- How many days a separation may sit uncleared before it is reported.
  clearance_sla_days integer not null default 7,
  updated_at         timestamptz not null default now(),
  constraint inventory_settings_sla_positive check (clearance_sla_days > 0)
);

alter table public.inventory_settings enable row level security;
drop policy if exists company_members on public.inventory_settings;
create policy company_members on public.inventory_settings for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.inventory_settings;
create policy ssa_all on public.inventory_settings for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists perm_write_upd on public.inventory_settings;
create policy perm_write_upd on public.inventory_settings as restrictive
  for update to public using (public.has_perm('inventory.edit'))
  with check (public.has_perm('inventory.edit'));
drop policy if exists perm_write_ins on public.inventory_settings;
create policy perm_write_ins on public.inventory_settings as restrictive
  for insert to public with check (public.has_perm('inventory.edit'));
grant select, insert, update on public.inventory_settings to authenticated;

insert into public.inventory_settings (company_id)
select c.id from public.companies c
 where not exists (select 1 from public.inventory_settings s where s.company_id = c.id);

comment on column public.inventory_settings.kit_required_from is
  '0430: deployments starting on or after this date require an open kit issuance, and deployed_without_kit() reports only from here. NULL = not in force, which is where it starts: 323 guards are deployed with no issuance because none of this existed, and a rule that refused all of them on day one would simply be turned off. DEFERRED — set it when the opening stocktake is entered.';

-- ---------------------------------------------------------------------------
-- 5. THE CHECK: every deployed guard has an open issuance.
-- ---------------------------------------------------------------------------
create or replace function public.deployed_without_kit(p_company_id uuid)
returns table (
  employee_id   uuid,
  employee_name text,
  client_id     uuid,
  site_id       uuid,
  start_date    date
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare v_from date;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select kit_required_from into v_from
    from public.inventory_settings where company_id = p_company_id;
  if v_from is null then return; end if;

  return query
  select e.id, e.full_name, d.client_id, d.site_id, d.start_date
    from public.deployments d
    join public.employees e on e.id = d.guard_id
   where d.company_id = p_company_id
     and d.end_date is null
     and d.start_date >= v_from
     and e.lifecycle_state = 'active'
     and not exists (
       select 1 from public.kit_holdings h
        where h.holder_employee_id = e.id and h.company_id = p_company_id)
   order by d.start_date, e.full_name;
end;
$fn$;

comment on function public.deployed_without_kit(uuid) is
  '0430: guards on an open posting that started on or after inventory_settings.kit_required_from and who hold no kit. Silent while that date is null, because 323 guards were deployed before any of this existed and a check red on arrival is a check people learn to ignore.';

revoke execute on function public.deployed_without_kit(uuid) from anon, public;
grant  execute on function public.deployed_without_kit(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. AND IT IS ENFORCED, not only reported.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_deployment_requires_kit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_from date; v_name text;
begin
  select kit_required_from into v_from
    from public.inventory_settings where company_id = new.company_id;
  if v_from is null or new.start_date < v_from then return new; end if;
  if new.end_date is not null then return new; end if;

  if not exists (select 1 from public.kit_holdings h where h.holder_employee_id = new.guard_id) then
    select full_name into v_name from public.employees where id = new.guard_id;
    raise exception
      '% has no kit. A guard is deployed only after he has been kitted — issue from the store, or record the handover from the guard he is replacing.',
      coalesce(v_name, 'This guard')
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_deployment_requires_kit on public.deployments;
create trigger trg_deployment_requires_kit
  before insert on public.deployments
  for each row execute function public.enforce_deployment_requires_kit();

-- ---------------------------------------------------------------------------
-- 7. THE THREE RPCs. Stock and the event in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.issue_kit(
  p_item_type_id uuid,
  p_to_employee  uuid default null,
  p_site_id      uuid default null,
  p_size         text default null,
  p_grade        text default 'new',
  p_serial       text default null,
  p_quantity     integer default 1,
  p_condition    text default 'new',
  p_event_date   date default null,
  p_notes        text default null)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_co uuid; v_stock public.inventory_stock%rowtype; v_client uuid; v_id uuid;
  v_branch uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;
  v_co := public.current_company_id();
  if p_to_employee is null and p_site_id is null then
    raise exception 'Kit is issued to a guard or to a client site. Name one.';
  end if;

  select * into v_stock from public.inventory_stock
   where company_id = v_co and item_type_id = p_item_type_id
     and coalesce(size, '') = coalesce(p_size, '')
     and grade = coalesce(nullif(p_grade, ''), 'new')::public.stock_grade
     and (p_serial is null or serial_number = p_serial)
   for update;

  if v_stock.id is null then
    raise exception 'No such stock in the store.';
  end if;
  if v_stock.quantity < p_quantity then
    raise exception 'Only % in stock; % were asked for.', v_stock.quantity, p_quantity;
  end if;

  -- THE CLIENT COMES FROM THE HOLDER'S DEPLOYMENT, at this moment, and is then
  -- frozen on the event. Reading it later would move the cost when he moves.
  if p_to_employee is not null then
    select d.client_id, d.branch_id into v_client, v_branch
      from public.deployments d
     where d.guard_id = p_to_employee and d.end_date is null
     order by d.start_date desc limit 1;
  else
    -- SITES CARRY NO REGION. `sites` is (id, company_id, client_id, name,
    -- location, is_default) and nothing else, so the branch comes from the
    -- client the site belongs to. Reading s.branch_id would simply not compile.
    select s.client_id, c.branch_id into v_client, v_branch
      from public.sites s
      left join public.clients c on c.id = s.client_id
     where s.id = p_site_id;
  end if;

  update public.inventory_stock
     set quantity = quantity - p_quantity, updated_at = now()
   where id = v_stock.id;

  insert into public.kit_events
    (company_id, branch_id, event, event_date, item_type_id, size, grade,
     serial_number, quantity, to_employee_id, site_id, client_id,
     condition, received_condition, unit_actual_cost, notes, created_by)
  values (v_co, v_branch, 'issue', coalesce(p_event_date, current_date),
          p_item_type_id, p_size, coalesce(nullif(p_grade, ''), 'new')::public.stock_grade,
          p_serial, p_quantity, p_to_employee, p_site_id, v_client,
          coalesce(nullif(p_condition, ''), 'new')::public.kit_condition,
          coalesce(nullif(p_condition, ''), 'new')::public.kit_condition,
          v_stock.unit_actual_cost, p_notes, auth.uid())
  returning id into v_id;

  update public.kit_events set issue_id = v_id where id = v_id;
  return v_id;
end;
$fn$;

create or replace function public.return_kit(
  p_issue_id   uuid,
  p_quantity   integer default null,
  p_condition  text default 'good',
  p_event_date date default null,
  p_notes      text default null)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_co uuid; v_h public.kit_holdings%rowtype; v_qty int; v_id uuid; v_stock uuid;
  v_grade public.stock_grade;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;
  v_co := public.current_company_id();

  select * into v_h from public.kit_holdings where issue_id = p_issue_id;
  if v_h.issue_id is null then raise exception 'That kit is not outstanding.'; end if;

  v_qty := least(coalesce(p_quantity, v_h.outstanding_qty), v_h.outstanding_qty);
  if v_qty <= 0 then raise exception 'Nothing to return.'; end if;

  -- UNUSABLE KIT DOES NOT GO BACK ON THE SHELF. It is written off at clearance
  -- (0432); putting it back would count scrap as stock.
  v_grade := 'used';
  if coalesce(nullif(p_condition, ''), 'good') <> 'unusable' then
    select id into v_stock from public.inventory_stock
     where company_id = v_co and item_type_id = v_h.item_type_id
       and coalesce(size, '') = coalesce(v_h.size, '')
       and grade = v_grade and serial_number is not distinct from v_h.serial_number
     for update;

    if v_stock is null then
      insert into public.inventory_stock
        (company_id, item_type_id, size, grade, serial_number, quantity, unit_actual_cost)
      values (v_co, v_h.item_type_id, v_h.size, v_grade, v_h.serial_number, v_qty,
              -- Used stock is carried at HALF REPLACEMENT COST. See 0432: the
              -- credit is a company-level recovery, never a retroactive credit
              -- to the client that consumed it.
              (select round(replacement_cost / 2, 2) from public.inventory_item_types
                where id = v_h.item_type_id));
    else
      update public.inventory_stock set quantity = quantity + v_qty, updated_at = now()
       where id = v_stock;
    end if;
  end if;

  insert into public.kit_events
    (company_id, branch_id, event, event_date, issue_id, item_type_id, size, grade,
     serial_number, quantity, from_employee_id, client_id, condition,
     unit_actual_cost, notes, created_by)
  values (v_co, v_h.branch_id, 'return', coalesce(p_event_date, current_date), p_issue_id,
          v_h.item_type_id, v_h.size, v_grade, v_h.serial_number, v_qty,
          v_h.holder_employee_id, v_h.client_id,
          coalesce(nullif(p_condition, ''), 'good')::public.kit_condition,
          v_h.unit_actual_cost, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end;
$fn$;

create or replace function public.handover_kit(
  p_issue_id     uuid,
  p_to_employee  uuid,
  p_condition    text default 'good',
  p_event_date   date default null,
  p_notes        text default null)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare v_co uuid; v_h public.kit_holdings%rowtype; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;
  v_co := public.current_company_id();

  select * into v_h from public.kit_holdings where issue_id = p_issue_id;
  if v_h.issue_id is null then raise exception 'That kit is not outstanding.'; end if;
  if v_h.holder_employee_id is null then
    raise exception 'Kit held by a site is handed over by changing who is responsible, not by a guard-to-guard handover.';
  end if;
  if v_h.holder_employee_id = p_to_employee then
    raise exception 'That guard already holds it.';
  end if;

  -- NO STOCK MOVEMENT AND NO POSTING. The kit never returns to the store and
  -- the client already absorbed the cost at first issue. A handover recorded as
  -- return + issue would charge the client twice for one uniform.
  insert into public.kit_events
    (company_id, branch_id, event, event_date, issue_id, item_type_id, size, grade,
     serial_number, quantity, from_employee_id, to_employee_id, site_id, client_id,
     condition, received_condition, unit_actual_cost, notes, created_by)
  values (v_co, v_h.branch_id, 'handover', coalesce(p_event_date, current_date), p_issue_id,
          v_h.item_type_id, v_h.size, v_h.grade, v_h.serial_number, v_h.outstanding_qty,
          v_h.holder_employee_id, p_to_employee, v_h.issued_site_id, v_h.client_id,
          coalesce(nullif(p_condition, ''), 'good')::public.kit_condition,
          -- HIS OPENING CONDITION. He is judged against the state he received
          -- it in, not against new.
          coalesce(nullif(p_condition, ''), 'good')::public.kit_condition,
          v_h.unit_actual_cost, p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end;
$fn$;

revoke execute on function public.issue_kit(uuid, uuid, uuid, text, text, text, integer, text, date, text) from anon, public;
grant  execute on function public.issue_kit(uuid, uuid, uuid, text, text, text, integer, text, date, text) to authenticated;
revoke execute on function public.return_kit(uuid, integer, text, date, text) from anon, public;
grant  execute on function public.return_kit(uuid, integer, text, date, text) to authenticated;
revoke execute on function public.handover_kit(uuid, uuid, text, date, text) from anon, public;
grant  execute on function public.handover_kit(uuid, uuid, text, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Probe. Rollback only. The handover is the assertion worth having.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_t uuid; v_g1 uuid; v_g2 uuid; v_issue uuid; v_n int; v_holder uuid;
  v_cond public.kit_condition;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  select id into v_g1 from public.employees where company_id = v_co order by created_at limit 1;
  select id into v_g2 from public.employees where company_id = v_co and id <> v_g1 order by created_at limit 1;
  if v_co is null or v_g2 is null then raise notice '0430: not enough fixture; skipped.'; return; end if;

  begin
    insert into public.inventory_item_types
      (company_id, name, category, issuable, replacement_cost, useful_life_months, sized)
    values (v_co, '0430 probe uniform', 'uniform', true, 3000, 24, true)
    returning id into v_t;

    insert into public.inventory_stock
      (company_id, item_type_id, size, grade, quantity, unit_actual_cost)
    values (v_co, v_t, 'L', 'new', 5, 1000);

    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       to_employee_id, condition, received_condition, unit_actual_cost)
    values (v_co, 'issue', null, v_t, 'L', 'new', 1, v_g1, 'new', 'new', 1000)
    returning id into v_issue;
    update public.kit_events set issue_id = v_issue where id = v_issue;

    select count(*) into v_n from public.kit_holdings where issue_id = v_issue;
    if v_n <> 1 then raise exception '0430 FAILED: an issue produced % holdings.', v_n; end if;

    -- HANDOVER MOVES THE HOLDING. It does not open a second one — that is what
    -- return+issue would do, and it would charge the client twice.
    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       from_employee_id, to_employee_id, condition, received_condition, unit_actual_cost)
    values (v_co, 'handover', v_issue, v_t, 'L', 'new', 1, v_g1, v_g2, 'rough', 'rough', 1000);

    select count(*) into v_n from public.kit_holdings;
    select holder_employee_id, opening_condition into v_holder, v_cond
      from public.kit_holdings where issue_id = v_issue;
    if v_holder <> v_g2 then
      raise exception '0430 FAILED: after a handover the holder is still the first guard.';
    end if;
    if v_cond <> 'rough' then
      raise exception '0430 FAILED: the receiving guard opens at % rather than the rough condition he actually took it on at. He would be fined for wear that was already there.', v_cond;
    end if;

    -- A full return closes the chain.
    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       from_employee_id, condition, unit_actual_cost)
    values (v_co, 'return', v_issue, v_t, 'L', 'used', 1, v_g2, 'fair', 1000);

    select count(*) into v_n from public.kit_holdings where issue_id = v_issue;
    if v_n <> 0 then raise exception '0430 FAILED: a fully returned chain is still outstanding.'; end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0430: probe passed — handover moves the holding and carries the received condition; a full return closes it.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0430 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
