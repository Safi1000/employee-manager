-- 0115: Employee & Attendance Module — Phase 1
--   Sites under clients, per-site shift_definitions, and an EXTENSION of the
--   existing billing contract_lines (0065) with site + shift strength / relief
--   / OT fields.
--
-- Design decisions (confirmed with product owner, Phase 1 of 9):
--   (a) SITES is a NEW table under clients. Today client == site (employees and
--       contracts hang directly off clients). Data derivation (default site per
--       real operating client, shift_definitions, strength lines) lives in the
--       companion seed 0116 so this schema migration stays data-free and the
--       seed can be scoped/re-run independently.
--   (b) The spec's more-detailed "contract_lines" (site + shift + billed_qty +
--       relief + OT + effective dating) EXTENDS the existing billing
--       contract_lines rather than becoming a separate table. All new columns
--       are additive and nullable / defaulted, so the live invoicing path
--       (committed_count, unit_rate) and employees.contract_line_id are
--       untouched. Two grains now coexist in one table:
--         * BILLING line   : committed_count + unit_rate, site_id NULL
--         * STRENGTH line  : site_id + shift_code + billed_qty (+ relief/OT)
--       Existing 36 rows are billing lines and are left as-is (site_id NULL).
--   (c) shift_definitions is ENTIRELY NEW. Shift previously existed only as free
--       text on employees.shift / roster_assignments.shift with no times.
--
-- No existing rows are modified except the additive columns' defaults. Nothing
-- is dropped or renamed.

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'shift_code') then
    create type shift_code as enum ('day', 'evening', 'night');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'relief_mode') then
    create type relief_mode as enum ('embedded', 'pool', 'none');
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. sites (clients ──< sites)
-- ---------------------------------------------------------------------------
create table if not exists public.sites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  client_id   uuid not null references public.clients(id)   on delete cascade,
  name        text not null,
  location    text,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_sites_company on public.sites(company_id);
create index if not exists idx_sites_client  on public.sites(client_id);

drop trigger if exists trg_aaa_sites_fill_company on public.sites;
create trigger trg_aaa_sites_fill_company
  before insert on public.sites
  for each row execute function public.fill_company_id();

drop trigger if exists trg_sites_updated_at on public.sites;
create trigger trg_sites_updated_at
  before update on public.sites
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_sites_audit on public.sites;
create trigger trg_zzz_sites_audit
  after insert or update or delete on public.sites
  for each row execute function public.log_audit_change();

alter table public.sites enable row level security;

drop policy if exists "ssa_all" on public.sites;
create policy "ssa_all" on public.sites for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.sites;
create policy "company_members" on public.sites for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Data (default sites) is seeded in 0116, scoped to real operating clients.

-- ---------------------------------------------------------------------------
-- 3. shift_definitions (sites ──< shift_definitions) — per-site shift with times
-- ---------------------------------------------------------------------------
create table if not exists public.shift_definitions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  site_id          uuid not null references public.sites(id)     on delete cascade,
  shift_code       shift_code not null,
  start_time       time not null,
  end_time         time not null,
  duration_hours   numeric(4,1) not null,
  crosses_midnight boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (site_id, shift_code)
);

create index if not exists idx_shift_definitions_company on public.shift_definitions(company_id);
create index if not exists idx_shift_definitions_site    on public.shift_definitions(site_id);

drop trigger if exists trg_aaa_shift_definitions_fill_company on public.shift_definitions;
create trigger trg_aaa_shift_definitions_fill_company
  before insert on public.shift_definitions
  for each row execute function public.fill_company_id();

drop trigger if exists trg_shift_definitions_updated_at on public.shift_definitions;
create trigger trg_shift_definitions_updated_at
  before update on public.shift_definitions
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_shift_definitions_audit on public.shift_definitions;
create trigger trg_zzz_shift_definitions_audit
  after insert or update or delete on public.shift_definitions
  for each row execute function public.log_audit_change();

alter table public.shift_definitions enable row level security;

drop policy if exists "ssa_all" on public.shift_definitions;
create policy "ssa_all" on public.shift_definitions for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.shift_definitions;
create policy "company_members" on public.shift_definitions for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 4. Extend contract_lines with the spec's strength / relief / OT fields.
--    All additive. Existing billing lines keep site_id NULL.
-- ---------------------------------------------------------------------------
alter table public.contract_lines
  add column if not exists site_id            uuid references public.sites(id) on delete cascade,
  add column if not exists shift_code         shift_code,
  add column if not exists billed_qty         integer,
  add column if not exists relief_allowance   integer not null default 0,
  add column if not exists required_on_ground integer generated always as
        (coalesce(billed_qty, 0) - coalesce(relief_allowance, 0)) stored,
  add column if not exists relief_mode        relief_mode not null default 'none',
  add column if not exists billing_rate       numeric(14,2),
  add column if not exists client_ot_rate     numeric(14,2),
  add column if not exists effective_from     date,
  add column if not exists effective_to       date;

create index if not exists idx_contract_lines_site on public.contract_lines(site_id);

comment on column public.contract_lines.site_id is
  '0115: NULL => legacy billing line (committed_count + unit_rate). NOT NULL => strength line keyed on site + shift (billed_qty/relief/OT).';
comment on column public.contract_lines.required_on_ground is
  '0115: generated = billed_qty - relief_allowance (strength lines only).';

-- ---------------------------------------------------------------------------
-- 5. Reconciliation view: contracted (billed_qty) vs enrolled (guard count).
--    security_invoker => underlying-table RLS applies as the querying user, so
--    it stays company-scoped and cannot leak across tenants.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_strength_reconciliation
with (security_invoker = true) as
select
  c.company_id,
  c.id                                                as client_id,
  c.name                                              as client_name,
  count(distinct s.id)                                as site_count,
  coalesce(sum(cl.billed_qty), 0)                     as contracted_billed_qty,
  coalesce(sum(cl.required_on_ground), 0)             as required_on_ground,
  (select count(*) from public.employees e
     where e.client_id = c.id and e.status = 'Active')  as enrolled_active,
  (select count(*) from public.employees e
     where e.client_id = c.id)                          as enrolled_total,
  coalesce(sum(cl.billed_qty), 0)
    - (select count(*) from public.employees e
         where e.client_id = c.id and e.status = 'Active') as variance
from public.clients c
left join public.sites s          on s.client_id = c.id
left join public.contract_lines cl on cl.site_id = s.id
group by c.company_id, c.id, c.name;
