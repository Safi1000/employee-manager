-- ============================================================================
-- DESCRIBES PRODUCTION. It does not change it.
--
-- This file was reverse-engineered FROM production (crm-design,
-- mmkfpnshxjcyijhuydgr), which already had this state before the file existed.
-- It is here so a from-scratch replay reaches the same shape, not because it
-- introduced anything.
--
-- Consequences, all of which have bitten:
--   * Production has NO schema_migrations row for it and correctly never will.
--     scripts/check-migrations.mjs reports it as "in repo, NOT recorded"; that
--     is expected for this class of file, not a defect to alias away.
--   * It is NOT safe to assume it runs at the position its number implies. It
--     was written long after the migrations that follow it, so applying it to
--     an existing database can undo later work. Guard anything order-sensitive.
--   * It reflects production as of the date it was recovered. If prod has moved
--     since, this file is stale and reconciling it is the fix.
-- ============================================================================

-- 0234: Drop NOT NULL from attendance_confirmations.client_id and .site_id.
--
-- Production has both nullable; the repo still declared them NOT NULL. A
-- category-scoped confirmation — the ones keyed by employee category rather than
-- by client, with group_key like 'cat:office_staff' — names neither a client nor
-- a site, so prod holds rows a repo-built database rejects outright.
--
-- Found by copying production data into a rebuilt database: the load failed on
-- these two columns. 0195's company-scoped unique index already treats both as
-- optional, so nothing else needs changing.

alter table public.attendance_confirmations
  alter column client_id drop not null,
  alter column site_id drop not null;
