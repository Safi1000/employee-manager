-- 0123: Phase 4 — deployments (postings) model + relief pool + backfill.
--
-- Internal name "deployments"; the UI labels it "Client" and the word
-- "deployment" never appears in the interface. The guard↔client relationship is
-- a DATED ROW, never edited in place (a change closes the old row and opens a
-- new one). One active (null end_date) row per guard.
--
-- Spec §12 ADDITIVE ONLY. The old single-assignment fields on employees
-- (contract_line_id, assignment_effective_from/to) are kept and deprecated;
-- employees.client_id is retained as a SYNCED MIRROR of the active posting so
-- the many existing client_id consumers keep working. "Current client" is
-- derived from the active deployment.
--
-- Confirmed decisions (Phase 4): client_id required + contract_line_id/site_id
-- nullable + post_id unused; internal 'GGS Relief Pool' client+site created and
-- the 2 relievers posted to it; start_date = coalesce(join_date, created_at);
-- one current posting per guard (3 moved guards flagged for manual history).

-- ---------------------------------------------------------------------------
-- 1. Reason enum + deployments table
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname='deployment_reason') then
    create type deployment_reason as enum
      ('new_hire','relief_cover','return_to_pool','separation','shift_change');
  end if;
end $$;

create table if not exists public.deployments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  guard_id         uuid not null references public.employees(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete restrict,
  contract_line_id uuid references public.contract_lines(id) on delete set null,
  site_id          uuid references public.sites(id) on delete set null,
  post_id          uuid,                      -- nullable, unused (no rotation)
  start_date       date not null,
  end_date         date,                      -- null = current
  reason           deployment_reason not null default 'new_hire',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists deployments_guard_idx  on public.deployments(guard_id);
create index if not exists deployments_client_idx on public.deployments(client_id);
create index if not exists deployments_line_idx   on public.deployments(contract_line_id);
-- One active (open) posting per guard.
create unique index if not exists deployments_one_active_per_guard
  on public.deployments(guard_id) where end_date is null;

drop trigger if exists trg_aaa_deployments_fill_company on public.deployments;
create trigger trg_aaa_deployments_fill_company
  before insert on public.deployments
  for each row execute function public.fill_company_id();

drop trigger if exists trg_deployments_updated_at on public.deployments;
create trigger trg_deployments_updated_at
  before update on public.deployments
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_deployments_audit on public.deployments;
create trigger trg_zzz_deployments_audit
  after insert or update or delete on public.deployments
  for each row execute function public.log_audit_change();

alter table public.deployments enable row level security;

drop policy if exists "ssa_all" on public.deployments;
create policy "ssa_all" on public.deployments for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.deployments;
create policy "company_members" on public.deployments for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 2. Internal 'GGS Relief Pool' client + site (per company that has relievers).
-- ---------------------------------------------------------------------------
insert into public.clients (company_id, name, client_type)
select distinct e.company_id, 'GGS Relief Pool', 'guard_deployment'
from public.employees e
where e.category::text = 'reliever'
  and not exists (select 1 from public.clients c
                  where c.company_id = e.company_id and c.name = 'GGS Relief Pool');

insert into public.sites (company_id, client_id, name, location, is_default)
select c.company_id, c.id, 'GGS Relief Pool', 'Internal relief pool', true
from public.clients c
where c.name = 'GGS Relief Pool'
  and not exists (select 1 from public.sites s where s.client_id = c.id);

-- ---------------------------------------------------------------------------
-- 3. Backfill one current posting per guard (before the sync trigger exists).
-- ---------------------------------------------------------------------------
-- 3a. Client-tagged guards -> posting to their current client + default site.
insert into public.deployments
  (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
select e.company_id, e.id, e.client_id, e.contract_line_id,
  (select s.id from public.sites s where s.client_id = e.client_id and s.is_default limit 1),
  coalesce(e.join_date, e.created_at::date), 'new_hire'
from public.employees e
where e.client_id is not null
  and not exists (select 1 from public.deployments d where d.guard_id = e.id);

-- 3b. Relievers -> posting to their company's relief pool.
insert into public.deployments
  (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
select e.company_id, e.id, pc.id, null, ps.id,
  coalesce(e.join_date, e.created_at::date), 'new_hire'
from public.employees e
join public.clients pc on pc.company_id = e.company_id and pc.name = 'GGS Relief Pool'
join public.sites   ps on ps.client_id = pc.id and ps.is_default
where e.category::text = 'reliever'
  and not exists (select 1 from public.deployments d where d.guard_id = e.id);

-- 3c. Mirror relievers' employees.client_id to the pool (only rows that change).
update public.employees e
set client_id = d.client_id
from public.deployments d
where d.guard_id = e.id and d.end_date is null
  and e.client_id is distinct from d.client_id;

-- ---------------------------------------------------------------------------
-- 4. Keep employees.client_id (+ display_number) synced to the active posting.
--    Clearing display_number on a client CHANGE lets Phase 2's
--    assign_display_number allocate the new per-client number without colliding.
-- ---------------------------------------------------------------------------
create or replace function public.sync_employee_active_client()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_guard  uuid;
  v_client uuid;
begin
  v_guard := coalesce(NEW.guard_id, OLD.guard_id);
  select client_id into v_client from public.deployments
    where guard_id = v_guard and end_date is null
    order by start_date desc, created_at desc limit 1;
  update public.employees e
     set client_id = v_client,
         display_number = case when v_client is distinct from e.client_id then null else e.display_number end,
         updated_at = now()
   where e.id = v_guard
     and (e.client_id is distinct from v_client);   -- no-op when unchanged
  return null;
end $$;

drop trigger if exists trg_deployments_sync_client on public.deployments;
create trigger trg_deployments_sync_client
  after insert or update or delete on public.deployments
  for each row execute function public.sync_employee_active_client();

-- ---------------------------------------------------------------------------
-- 5. change_client(): the ONLY way to move a guard. Closes the current row and
--    opens a new one (never edits in place). Handles same-client shift changes
--    (pass the same client with a new contract line + reason='shift_change').
--    Draft guards cannot be transferred (Phase 3D gate).
-- ---------------------------------------------------------------------------
create or replace function public.change_client(
  p_guard_id         uuid,
  p_new_client_id    uuid,
  p_contract_line_id uuid default null,
  p_site_id          uuid default null,
  p_reason           deployment_reason default 'relief_cover',
  p_effective_date   date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_state   record_state;
  v_eff     date;
  v_site    uuid;
  v_start   date;
  v_new_id  uuid;
begin
  select company_id, record_state into v_company, v_state
    from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Guard % not found', p_guard_id; end if;
  if v_state = 'draft' then
    raise exception 'Guard must be Ops-verified before being posted to a client';
  end if;

  v_eff  := coalesce(p_effective_date, current_date);
  v_site := coalesce(p_site_id,
    (select id from public.sites where client_id = p_new_client_id and is_default limit 1));

  -- Close the current active row (active through the day before the new start).
  select start_date into v_start from public.deployments
    where guard_id = p_guard_id and end_date is null;
  update public.deployments
     set end_date = greatest(coalesce(v_start, v_eff - 1), v_eff - 1), updated_at = now()
   where guard_id = p_guard_id and end_date is null;

  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
  values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, p_reason)
  returning id into v_new_id;

  return v_new_id;
end $$;

grant execute on function public.change_client(uuid, uuid, uuid, uuid, deployment_reason, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reconcile the Phase-3D posting gate with Phase-4 silent-posting-at-hiring:
--    allow a draft guard's FIRST client assignment (hiring), but still block
--    TRANSFERS of a draft guard (OLD.client_id already set). record_state
--    continues to gate roster/attendance visibility elsewhere.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_posting_requires_ops_verified()
returns trigger language plpgsql as $$
begin
  if NEW.client_id is not null
     and OLD.client_id is not null                      -- only a transfer, not first hire
     and NEW.client_id is distinct from OLD.client_id
     and NEW.record_state = 'draft' then
    raise exception 'Guard must be Ops-verified before being transferred to another client';
  end if;
  return NEW;
end $$;
