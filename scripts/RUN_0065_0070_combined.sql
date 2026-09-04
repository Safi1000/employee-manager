-- Combined reconciled Phases 1-6 migrations (0065-0070). Run top-to-bottom
-- in the crm-design SQL Editor, AFTER main's 0063/0064 are applied. Order
-- matters. Then run the REVIEW QUERIES in 0065 (guard_rates backfill checks).

-- ============================================================
-- 0065_contract_lines.sql
-- ============================================================
-- 0065: Contract Lines — per-category committed headcount + rate (RECONCILED).
--
-- Phase 1 of the "Contracts, Client-Employee Linkage & Invoice Generation" spec,
-- reconciled onto main after the team agreed contract_lines is the winning
-- design for guard category/count/rate. It supersedes main's `guard_rates` JSONB
-- (0063_contract_shifts_types_drive), which stored a rate per guard TYPE but no
-- count. Per-shift day/night/evening_guards are KEPT untouched as informational
-- shift detail — they are no longer treated as "the" guard count.
--
-- Contract value going forward = Σ(committed_count × unit_rate).

-- ---------------------------------------------------------------------------
-- 1. Category enum (7 fixed categories; extensible in a later migration).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'contract_line_category') then
    create type contract_line_category as enum (
      'SR_SUPERVISOR',
      'SUPERVISOR',
      'ASST_SUPERVISOR',
      'GUARD',
      'RELIEVER',
      'WEAPON',
      'EQUIPMENT'
    );
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 2. contract_lines table
-- ---------------------------------------------------------------------------
create table if not exists public.contract_lines (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  contract_id      uuid not null references public.contracts(id) on delete cascade,
  category         contract_line_category not null,
  label            text,
  location         text,
  committed_count  integer not null default 0,
  unit_rate        numeric(14,2) not null default 0,
  cost_components  jsonb,           -- Phase-5-ready SLA build-up; unused for now
  taxable          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_contract_lines_company  on public.contract_lines(company_id);
create index if not exists idx_contract_lines_contract on public.contract_lines(contract_id);
create index if not exists idx_contract_lines_category on public.contract_lines(category);

drop trigger if exists trg_aaa_contract_lines_fill_company on public.contract_lines;
create trigger trg_aaa_contract_lines_fill_company
  before insert on public.contract_lines
  for each row execute function public.fill_company_id();

drop trigger if exists trg_contract_lines_updated_at on public.contract_lines;
create trigger trg_contract_lines_updated_at
  before update on public.contract_lines
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS (same pattern as contracts)
-- ---------------------------------------------------------------------------
alter table public.contract_lines enable row level security;

drop policy if exists "ssa_all" on public.contract_lines;
create policy "ssa_all" on public.contract_lines for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.contract_lines;
create policy "company_members" on public.contract_lines for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 4. Audit trigger (generic logger from 0041) — new writes show up in the
--    Audit Log automatically, no app-side call needed.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_zzz_contract_lines_audit on public.contract_lines;
create trigger trg_zzz_contract_lines_audit
  after insert or update or delete on public.contract_lines
  for each row execute function public.log_audit_change();

-- ---------------------------------------------------------------------------
-- 5. Backfill from main's guard_rates (RECONCILED).
--
--    Priority per contract (skip contracts that already have lines):
--      (a) guard_rates has rated types → one line per rated type, committed_count
--          = 1 (matching guard_rates' own one-per-type assumption), unit_rate =
--          that rate, category mapped + human label preserved (Option A).
--      (b) else number_of_guards > 0 → one GUARD line with that count/rate, so a
--          contract that only ever had a plain headcount doesn't lose it.
--      (c) else → no lines.
--
--    Guard-type → category map (label-based, keeps the 7 categories as-is):
--      senior_supervisor    → SR_SUPERVISOR   "Senior Supervisor"
--      assistant_supervisor → ASST_SUPERVISOR "Assistant Supervisor"
--      supervisor           → SUPERVISOR      "Supervisor"
--      ex_military          → GUARD           "Ex-Military"
--      civ_guard            → GUARD           "Civ Guard"
--      walkie_talkie        → EQUIPMENT       "Walkie Talkie"
--      weapons_guard        → WEAPON          "Weapons Guard"
-- ---------------------------------------------------------------------------
do $$
declare
  c            record;
  v_key        text;
  v_rate       numeric;
  v_cat        contract_line_category;
  v_label      text;
  v_made       boolean;
begin
  for c in
    select * from public.contracts ct
    where not exists (select 1 from public.contract_lines cl where cl.contract_id = ct.id)
  loop
    v_made := false;

    -- (a) guard_rates path
    if c.guard_rates is not null and jsonb_typeof(c.guard_rates) = 'object' then
      for v_key, v_rate in
        select k, (v)::text::numeric
        from jsonb_each_text(c.guard_rates) as e(k, v)
        where v ~ '^[0-9]+(\.[0-9]+)?$'
      loop
        if v_rate is null then continue; end if;
        v_cat := case v_key
                   when 'senior_supervisor'    then 'SR_SUPERVISOR'
                   when 'assistant_supervisor' then 'ASST_SUPERVISOR'
                   when 'supervisor'           then 'SUPERVISOR'
                   when 'ex_military'          then 'GUARD'
                   when 'civ_guard'            then 'GUARD'
                   when 'walkie_talkie'        then 'EQUIPMENT'
                   when 'weapons_guard'        then 'WEAPON'
                   else 'GUARD'
                 end::contract_line_category;
        v_label := case v_key
                     when 'senior_supervisor'    then 'Senior Supervisor'
                     when 'assistant_supervisor' then 'Assistant Supervisor'
                     when 'supervisor'           then 'Supervisor'
                     when 'ex_military'          then 'Ex-Military'
                     when 'civ_guard'            then 'Civ Guard'
                     when 'walkie_talkie'        then 'Walkie Talkie'
                     when 'weapons_guard'        then 'Weapons Guard'
                     else initcap(replace(v_key, '_', ' '))
                   end;
        insert into public.contract_lines
          (company_id, contract_id, category, label, committed_count, unit_rate, taxable)
        values (c.company_id, c.id, v_cat, v_label, 1, v_rate, true);
        v_made := true;
      end loop;
    end if;

    -- (b) fallback: plain headcount, no per-type rates
    if not v_made and coalesce(c.number_of_guards, 0) > 0 then
      insert into public.contract_lines
        (company_id, contract_id, category, label, committed_count, unit_rate, taxable)
      values (c.company_id, c.id, 'GUARD', 'Guard',
              c.number_of_guards, coalesce(c.rate_per_guard_per_month, 0), true);
    end if;
  end loop;
end$$;

-- ---------------------------------------------------------------------------
-- 6. Deprecate guard_rates (DO NOT DROP). contract_lines fully supersedes it.
--    Kept in place so nothing breaks mid-transition; remove in a later cleanup.
-- ---------------------------------------------------------------------------
comment on column public.contracts.guard_rates is
  'DEPRECATED (0065): superseded by contract_lines (category + committed_count + unit_rate). No longer read/written by the app. Retained temporarily; safe to drop in a later migration.';

-- day_guards / night_guards / evening_guards are intentionally LEFT AS-IS —
-- they remain as informational shift detail, not a guard count.

-- ---------------------------------------------------------------------------
-- 7. REVIEW QUERIES (no data change).
--
--   7a. Contracts where the count=1-per-type backfill likely UNDERCOUNTS —
--       the day/night/evening shift totals imply more guards than the number of
--       lines created. Fix committed_count by hand for these.
--
--     select c.contract_code, c.id,
--            (c.day_guards + c.night_guards + c.evening_guards) as shift_total,
--            coalesce(sum(cl.committed_count), 0)               as backfilled_total
--     from public.contracts c
--     left join public.contract_lines cl on cl.contract_id = c.id
--     group by c.id, c.contract_code, c.day_guards, c.night_guards, c.evening_guards
--     having (c.day_guards + c.night_guards + c.evening_guards)
--            > coalesce(sum(cl.committed_count), 0)
--     order by c.contract_code;
--
--   7b. Contracts left with NO lines at all (no guard_rates, no headcount):
--
--     select c.contract_code, c.id
--     from public.contracts c
--     where not exists (select 1 from public.contract_lines cl where cl.contract_id = c.id)
--     order by c.contract_code;
-- ---------------------------------------------------------------------------


-- ============================================================
-- 0066_contract_addendums.sql
-- ============================================================
-- 0064: Contract Addendums (Phase 2).
--
-- An addendum records a change to a contract's committed headcount or rate that
-- takes effect from a date, without mutating the original contract_lines base.
-- Effective committed count for a category on a date =
--   base committed_count (contract_lines)
--   + Σ addendum count_deltas for that line/category where effective_from <= date.
--
-- Depends on 0063 (contract_lines + contract_line_category).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'addendum_change_type') then
    create type addendum_change_type as enum ('ADD_HEADCOUNT', 'REDUCE_HEADCOUNT', 'RATE_CHANGE');
  end if;
  if not exists (select 1 from pg_type where typname = 'addendum_source') then
    create type addendum_source as enum ('SIGNED_CONTRACT', 'EMAIL', 'VERBAL', 'OTHER');
  end if;
end$$;

create table if not exists public.contract_addendums (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  contract_id       uuid not null references public.contracts(id) on delete cascade,
  -- Null contract_line_id means the addendum introduces a NEW line; `category`
  -- then names which category it adds to.
  contract_line_id  uuid references public.contract_lines(id) on delete set null,
  category          contract_line_category,
  change_type       addendum_change_type not null,
  count_delta       integer not null default 0,
  new_rate          numeric(14,2),
  effective_from    date not null,
  source            addendum_source not null default 'OTHER',
  reference         text,
  -- Optional uploaded reference document (same Drive pattern as contracts).
  drive_file_id     text,
  drive_view_url    text,
  reference_file_name text,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_contract_addendums_company  on public.contract_addendums(company_id);
create index if not exists idx_contract_addendums_contract on public.contract_addendums(contract_id);
create index if not exists idx_contract_addendums_line     on public.contract_addendums(contract_line_id);
create index if not exists idx_contract_addendums_eff      on public.contract_addendums(effective_from);

drop trigger if exists trg_aaa_contract_addendums_fill_company on public.contract_addendums;
create trigger trg_aaa_contract_addendums_fill_company
  before insert on public.contract_addendums
  for each row execute function public.fill_company_id();

drop trigger if exists trg_contract_addendums_updated_at on public.contract_addendums;
create trigger trg_contract_addendums_updated_at
  before update on public.contract_addendums
  for each row execute function public.touch_updated_at();

alter table public.contract_addendums enable row level security;

drop policy if exists "ssa_all" on public.contract_addendums;
create policy "ssa_all" on public.contract_addendums for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.contract_addendums;
create policy "company_members" on public.contract_addendums for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Audit trigger — addendum creates/edits show up in the Audit Log automatically.
drop trigger if exists trg_zzz_contract_addendums_audit on public.contract_addendums;
create trigger trg_zzz_contract_addendums_audit
  after insert or update or delete on public.contract_addendums
  for each row execute function public.log_audit_change();


-- ============================================================
-- 0067_client_billing_tax.sql
-- ============================================================
-- 0065: Client billing/tax profile (Phase 3).
--
-- Replaces the single withholding_tax_rate with a repeatable tax_profile, and
-- adds billing_type, invoice_group, and remit_accounts. The legacy
-- withholding_tax_rate / auto_invoice_withholding columns are kept and the app
-- mirrors the first WITHHELD tax into them so existing auto-invoice logic is
-- unaffected.
--
-- tax_profile: jsonb array of
--   { name, rate, base: WHOLE_INVOICE|SPECIFIC_COMPONENT|COMPOUND,
--     direction: ADDED|WITHHELD, component? }
-- remit_accounts: jsonb array of
--   { account_title, account_number, bank_name, is_default }
--
-- client_code is already `text unique` with an auto-gen trigger (0001) — its
-- uniqueness is enforced at the DB level, so no change is needed here.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'client_billing_type') then
    create type client_billing_type as enum ('STANDARD', 'SLA');
  end if;
  if not exists (select 1 from pg_type where typname = 'client_invoice_group') then
    create type client_invoice_group as enum ('FIXED', 'VARIABLE', 'SLA');
  end if;
end$$;

alter table public.clients
  add column if not exists tax_profile    jsonb not null default '[]'::jsonb,
  add column if not exists remit_accounts jsonb not null default '[]'::jsonb,
  add column if not exists billing_type   client_billing_type not null default 'STANDARD',
  add column if not exists invoice_group  client_invoice_group not null default 'FIXED';

-- Backfill tax_profile from the existing single withholding rate so no client
-- silently loses its WHT. Only for clients that have a rate and no profile yet.
update public.clients
   set tax_profile = jsonb_build_array(
         jsonb_build_object(
           'name', 'Withholding Tax',
           'rate', withholding_tax_rate,
           'base', 'WHOLE_INVOICE',
           'direction', 'WITHHELD'
         )
       )
 where withholding_tax_rate is not null
   and withholding_tax_rate > 0
   and (tax_profile is null or tax_profile = '[]'::jsonb);

-- clients is already in the audited-tables list (0041), so tax_profile /
-- remit_accounts changes are captured in the Audit Log automatically.


-- ============================================================
-- 0068_employee_contract_line_assignment.sql
-- ============================================================
-- 0066: Employee ↔ Contract Line assignment (Phase 4).
--
-- Ties an employee to a specific contract_line (category slot) with an
-- assignment-specific effective window, distinct from the general join_date.
-- We EXTEND employees (rather than add a parallel table) so the existing
-- "count active employees on this contract" logic keeps a single source of
-- truth — the same rows now also carry which line/category they fill.
--
-- Depends on 0063 (contract_lines).

alter table public.employees
  add column if not exists contract_line_id           uuid references public.contract_lines(id) on delete set null,
  add column if not exists assignment_effective_from  date,
  add column if not exists assignment_effective_to    date;

create index if not exists idx_employees_contract_line on public.employees(contract_line_id);

-- Backfill: for employees already tagged to a contract that has exactly ONE
-- line (the Phase-1 backfilled GUARD line), assign them to that line and seed
-- effective_from from their join date (falling back to the contract start).
-- Employees on contracts with multiple lines are LEFT UNASSIGNED (contract_line_id
-- stays null) — their category can't be inferred and must be set by hand.
update public.employees e
   set contract_line_id = single.line_id,
       assignment_effective_from = coalesce(e.join_date, single.start_date)
  from (
    select cl.contract_id,
           min(cl.id)        as line_id,
           count(*)          as n,
           min(c.start_date) as start_date
      from public.contract_lines cl
      join public.contracts c on c.id = cl.contract_id
     group by cl.contract_id
    having count(*) = 1
  ) single
 where e.contract_id = single.contract_id
   and e.contract_line_id is null;

-- REVIEW QUERY (no data change) — employees on a client contract but with no
-- line assignment (multi-line contracts, or contracts with no lines). Assign
-- these to a category slot by hand from the Employee modal.
--
--   select e.employee_code, e.full_name, c.contract_code
--   from public.employees e
--   join public.contracts c on c.id = e.contract_id
--   where e.contract_id is not null
--     and e.contract_line_id is null
--   order by c.contract_code, e.full_name;

-- employees is already in the audited-tables list (0041): assignment /
-- reassignment changes are captured in the Audit Log automatically.


-- ============================================================
-- 0069_attendance_bulk_events.sql
-- ============================================================
-- 0067: Attendance bulk-action audit events (Phase 5b).
--
-- attendance_records is intentionally NOT in the generic audited-tables list
-- (per-day marks would flood the Audit Log). But the spec requires the bulk
-- "Mark All Present" and its "Undo" to each appear as ONE distinct audit entry.
--
-- We record each bulk action as a single row here; the generic audit trigger
-- (0041) then produces exactly one audit_log entry per action, visible in
-- ADMIN → Audit Log alongside everything else.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_bulk_action') then
    create type attendance_bulk_action as enum ('mark_all_present', 'undo_mark_all_present');
  end if;
end$$;

create table if not exists public.attendance_bulk_events (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  action           attendance_bulk_action not null,
  attendance_date  date not null,
  affected_count   integer not null default 0,
  -- The filters active on the page when the action ran (client/location/etc.).
  filters          jsonb,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_attendance_bulk_events_company on public.attendance_bulk_events(company_id);
create index if not exists idx_attendance_bulk_events_date    on public.attendance_bulk_events(attendance_date);

drop trigger if exists trg_aaa_attendance_bulk_events_fill_company on public.attendance_bulk_events;
create trigger trg_aaa_attendance_bulk_events_fill_company
  before insert on public.attendance_bulk_events
  for each row execute function public.fill_company_id();

alter table public.attendance_bulk_events enable row level security;

drop policy if exists "ssa_all" on public.attendance_bulk_events;
create policy "ssa_all" on public.attendance_bulk_events for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.attendance_bulk_events;
create policy "company_members" on public.attendance_bulk_events for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- One audit_log entry per bulk action.
drop trigger if exists trg_zzz_attendance_bulk_events_audit on public.attendance_bulk_events;
create trigger trg_zzz_attendance_bulk_events_audit
  after insert or update or delete on public.attendance_bulk_events
  for each row execute function public.log_audit_change();


-- ============================================================
-- 0070_invoice_generation.sql
-- ============================================================
-- 0068: Invoice generation detail (Phase 6).
--
-- Extends invoices with the Generate-workflow fields and adds invoice_lines /
-- invoice_taxes for itemized, multi-tax invoices. Also broadens the status
-- CHECK to carry payment state (Unpaid / Partly-Paid / Paid) alongside the
-- existing delivery states (Pending / Delivered) so generated invoices post as
-- Unpaid without disturbing the legacy ad-hoc flow.
--
-- Depends on 0063 (contract_line_category) and 0065 (client_invoice_group).

-- ---------------------------------------------------------------------------
-- 1. Broaden the invoice status set.
-- ---------------------------------------------------------------------------
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('Pending', 'Delivered', 'Unpaid', 'Partly-Paid', 'Paid'));

-- ---------------------------------------------------------------------------
-- 2. Generation fields on invoices.
--    invoice_amount keeps meaning "current-period gross (subtotal + added tax)"
--    and withholding_tax keeps meaning "withheld total", so the existing list's
--    outstanding math (invoice_amount − withholding_tax − amount_received) still
--    holds. The new columns carry the richer breakdown + presentation data.
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists period_start        date,
  add column if not exists period_end          date,
  add column if not exists subtotal            numeric(14,2) not null default 0,
  add column if not exists tax_added_total      numeric(14,2) not null default 0,
  add column if not exists tax_withheld_total   numeric(14,2) not null default 0,
  add column if not exists previous_balance     numeric(14,2) not null default 0,
  add column if not exists total_due            numeric(14,2) not null default 0,
  add column if not exists amount_in_words      text,
  add column if not exists remit_account        jsonb,
  add column if not exists override_reason      text,
  add column if not exists financial_year       text,
  add column if not exists invoice_group        client_invoice_group,
  add column if not exists generated            boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Invoice line items.
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  category     contract_line_category,
  label        text not null,
  quantity     integer not null default 0,
  unit_rate    numeric(14,2) not null default 0,
  amount       numeric(14,2) not null default 0,
  taxable      boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_invoice_lines_invoice on public.invoice_lines(invoice_id);
create index if not exists idx_invoice_lines_company on public.invoice_lines(company_id);

-- ---------------------------------------------------------------------------
-- 4. Invoice tax lines (snapshot of the client's tax_profile at generation).
-- ---------------------------------------------------------------------------
create table if not exists public.invoice_taxes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  invoice_id   uuid not null references public.invoices(id) on delete cascade,
  name         text not null,
  rate         numeric(6,3) not null default 0,
  base         text not null default 'WHOLE_INVOICE',
  direction    text not null default 'ADDED',
  component    text,
  amount       numeric(14,2) not null default 0,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists idx_invoice_taxes_invoice on public.invoice_taxes(invoice_id);
create index if not exists idx_invoice_taxes_company on public.invoice_taxes(company_id);

-- ---------------------------------------------------------------------------
-- 5. Triggers + RLS for the two new tables (same pattern as everywhere).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['invoice_lines', 'invoice_taxes'] loop
    execute format('drop trigger if exists trg_aaa_%I_fill_company on public.%I', t, t);
    execute format('create trigger trg_aaa_%I_fill_company before insert on public.%I for each row execute function public.fill_company_id()', t, t);

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%I', t);
    execute format('create policy "ssa_all" on public.%I for all using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%I', t);
    execute format('create policy "company_members" on public.%I for all using (company_id = public.current_company_id()) with check (company_id = public.current_company_id())', t);

    execute format('drop trigger if exists trg_zzz_%I_audit on public.%I', t, t);
    execute format('create trigger trg_zzz_%I_audit after insert or update or delete on public.%I for each row execute function public.log_audit_change()', t, t);
  end loop;
end$$;

-- invoices is already audited (0041): generation / clearing / override edits
-- are captured in the Audit Log automatically.


