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
