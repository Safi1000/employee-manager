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
