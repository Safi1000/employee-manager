-- 0063: Contract per-shift guard counts, guard rates, contract types,
--        employee/roster evening shift, drive cols on cash_deposits.

-- ── 1. Per-shift guard columns on contracts ──────────────────────────────────
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS day_guards     INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS night_guards   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evening_guards INT NOT NULL DEFAULT 0;

-- Backfill from old number_of_guards + shift_pattern
UPDATE public.contracts SET
  day_guards = CASE
    WHEN shift_pattern::text = 'day'    THEN number_of_guards
    WHEN shift_pattern::text = 'both'   THEN CEIL(number_of_guards / 2.0)::INT
    WHEN shift_pattern::text = 'custom' THEN number_of_guards
    ELSE 0
  END,
  night_guards = CASE
    WHEN shift_pattern::text = 'night'  THEN number_of_guards
    WHEN shift_pattern::text = 'both'   THEN FLOOR(number_of_guards / 2.0)::INT
    ELSE 0
  END,
  evening_guards = 0;

-- ── 2. Guard rates (JSONB) ────────────────────────────────────────────────────
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS guard_rates JSONB NOT NULL DEFAULT '{}';

-- ── 3. Contract type: services | guard_deployment ────────────────────────────
-- Drop the enum-typed DEFAULT before altering the column type.
ALTER TABLE public.contracts ALTER COLUMN contract_type DROP DEFAULT;
ALTER TABLE public.contracts ALTER COLUMN contract_type TYPE text;
DROP TYPE IF EXISTS contract_type;

UPDATE public.contracts SET contract_type = 'guard_deployment' WHERE contract_type = 'reliever_pool';
UPDATE public.contracts SET contract_type = 'services'
  WHERE contract_type IN ('static', 'mobile_patrol', 'event');

ALTER TABLE public.contracts
  DROP CONSTRAINT IF EXISTS contracts_contract_type_check;
ALTER TABLE public.contracts
  ADD CONSTRAINT contracts_contract_type_check
    CHECK (contract_type IN ('services', 'guard_deployment'));

-- ── 4. Evening shift on employees (column is already text — add check) ────────
ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_shift_check;
ALTER TABLE public.employees
  ADD CONSTRAINT employees_shift_check
    CHECK (shift IN ('day', 'night', 'evening'));

-- ── 5. Evening shift on roster_assignments (roster_shift ENUM → text + check) ─
-- Drop the enum-typed DEFAULT, convert to text, re-add DEFAULT as plain text.
ALTER TABLE public.roster_assignments ALTER COLUMN shift DROP DEFAULT;
ALTER TABLE public.roster_assignments ALTER COLUMN shift TYPE text;
DROP TYPE IF EXISTS roster_shift;
ALTER TABLE public.roster_assignments ALTER COLUMN shift SET DEFAULT 'day';
ALTER TABLE public.roster_assignments
  DROP CONSTRAINT IF EXISTS roster_assignments_shift_check;
ALTER TABLE public.roster_assignments
  ADD CONSTRAINT roster_assignments_shift_check
    CHECK (shift IN ('day', 'night', 'evening'));

-- ── 6. Drive file storage on cash_deposits ───────────────────────────────────
ALTER TABLE public.cash_deposits
  ADD COLUMN IF NOT EXISTS drive_file_id  TEXT,
  ADD COLUMN IF NOT EXISTS drive_view_url TEXT;
