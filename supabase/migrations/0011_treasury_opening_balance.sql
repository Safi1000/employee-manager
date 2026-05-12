-- ============================================================================
-- ADDITIVE migration. No data loss.
-- treasury gains a one-time opening cash balance that locks after first set.
-- cash_balance (live running balance) is unchanged by this migration; setting
-- opening from the UI credits the live balance once via a 'cash_adjustment'
-- transaction row.
-- ============================================================================

alter table public.treasury
  add column if not exists cash_opening_balance numeric(14,2) not null default 0;

alter table public.treasury
  add column if not exists cash_opening_locked boolean not null default false;
