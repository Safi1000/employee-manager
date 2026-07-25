-- 0119: Phase 3A — additive guard record fields + approval/lifecycle enums.
--
-- Spec §12 ADDITIVE ONLY: nothing is dropped. Existing overlapping columns are
-- kept and reused (join_date=joining_date, eligible_for_rehire=rehire_eligible,
-- form_serial_no=paper_form_serial, exit_date/exit_reason remain). New fields are
-- added alongside.
--
-- Confirmed decisions (product owner, Phase 3A):
--   * separation_reason enum values (the separation FLOW is Phase 7 — enum only).
--   * record_state backfill: status='Active' => 'active', else 'draft'.
--   * employee_category gains 'armed' and 'gunman' (Tier-4 armed-post eligibility).
--   * group_insurance_status enum: active / inactive / not_enrolled.
--   * CNIC: 2 duplicate groups exist, so NO hard unique constraint yet — a plain
--     lookup index is added and uniqueness/13-digit is enforced in the app;
--     the 2 dups are surfaced for manual cleanup before a future unique index.

-- ---------------------------------------------------------------------------
-- 1. New enums
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname='record_state') then
    create type record_state as enum ('draft','ops_verified','finance_approved','active');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname='separation_reason') then
    create type separation_reason as enum (
      'resignation','termination_misconduct','termination_performance','absconded',
      'contract_end','retirement','medical_unfit','deceased','redundancy','transfer_out');
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname='group_insurance_status') then
    create type group_insurance_status as enum ('active','inactive','not_enrolled');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Extend existing enums (additive; all current values kept).
--    New values are NOT used elsewhere in this migration (safe in one tx).
-- ---------------------------------------------------------------------------
alter type employee_category        add value if not exists 'armed';
alter type employee_category        add value if not exists 'gunman';
alter type employee_lifecycle_state add value if not exists 'fired';
alter type employee_lifecycle_state add value if not exists 'absconded';
alter type employee_lifecycle_state add value if not exists 'archived';

-- ---------------------------------------------------------------------------
-- 3. New columns on employees (all additive / nullable-or-defaulted).
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists record_state             record_state not null default 'draft',
  add column if not exists separation_reason        separation_reason,
  add column if not exists last_working_day         date,
  add column if not exists termination_date         date,
  add column if not exists account_title            text,
  add column if not exists bank_branch_code         text,
  add column if not exists home_contact_number      text,
  add column if not exists probation_period_months  integer,
  add column if not exists pay_fixed_on_probation   numeric(14,2),
  add column if not exists final_pay                numeric(14,2),
  add column if not exists group_insurance_status   group_insurance_status,
  add column if not exists cash_payment_flag        boolean not null default false,
  add column if not exists cash_payment_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists unit_type                text,
  add column if not exists last_unit                text,
  -- §3H: dedicated column for the "(NG)"/(AK)/(Drv)/… name-suffix codes.
  -- Added EMPTY now; names are NOT stripped until the codes' meaning is confirmed.
  add column if not exists name_suffix_code         text;

comment on column public.employees.record_state is
  '0119 §4 approval state machine: draft → ops_verified → finance_approved → active.';
comment on column public.employees.name_suffix_code is
  '0119 §3H: parsed name-suffix code (NG/AK/Drv/…). Empty until meaning confirmed; names not yet stripped.';

-- ---------------------------------------------------------------------------
-- 4. Backfill record_state: keep current operations working.
--    Active guards are treated as fully approved so existing posting/payroll is
--    not blocked by the new gates; everyone else starts at draft.
-- ---------------------------------------------------------------------------
update public.employees set record_state = 'active' where status = 'Active';

-- ---------------------------------------------------------------------------
-- 5. Indexes: paper form serial (§2.1 "indexed") + CNIC lookup (non-unique;
--    uniqueness enforced in-app until the 2 duplicate groups are resolved).
-- ---------------------------------------------------------------------------
create index if not exists employees_form_serial_no_idx
  on public.employees (form_serial_no) where form_serial_no is not null;

create index if not exists employees_cnic_number_idx
  on public.employees (company_id, cnic_number) where cnic_number is not null;
