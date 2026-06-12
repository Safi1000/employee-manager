-- Additive schema for the Clients/Contracts/Settings/Profile work batch.
-- All columns are nullable or defaulted so existing rows and code keep working.
--
--   * Item 6  — Company Profile settings: address / tax / currency / fiscal year / logo
--   * Item 7  — Personal profile for SA & SSA: per-user avatar (full_name + email
--               already exist on profiles and are used for display)
--   * Item 15 — Bank accounts get an active flag (activate/deactivate instead of delete)

-- ---------------------------------------------------------------------------
-- Item 6: Company Profile fields on companies
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists legal_address         text,
  add column if not exists tax_ntn               text,
  add column if not exists presentation_currency text not null default 'PKR',
  add column if not exists fiscal_year_start      text not null default 'July',
  add column if not exists logo_url               text;

-- ---------------------------------------------------------------------------
-- Item 7: per-user avatar. Stored as a URL or small data-URL string; full_name
-- and email already exist on profiles and drive the app-shell display.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_url text;

-- ---------------------------------------------------------------------------
-- Item 15: bank accounts are activated / deactivated rather than deleted.
-- ---------------------------------------------------------------------------
alter table public.bank_accounts
  add column if not exists active boolean not null default true;
