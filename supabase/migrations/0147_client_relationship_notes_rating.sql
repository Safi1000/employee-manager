-- 0147: Client relationship notes + rating (consolidation Decision 3).
--
-- The old "Client Relationships" panel is dissolved: complaints move to
-- Operations ▸ Incidents and renewals to Compliance ▸ Licenses & Renewals.
-- Service reviews/ratings — the orphan — fold into the client record as a
-- light notes field plus an optional 1–5 rating. No new table, no workflow;
-- just two nullable columns edited from the client modal.

alter table public.clients
  add column if not exists relationship_notes text;

alter table public.clients
  add column if not exists relationship_rating smallint;

alter table public.clients
  drop constraint if exists clients_relationship_rating_range;
alter table public.clients
  add constraint clients_relationship_rating_range
  check (relationship_rating is null or relationship_rating between 1 and 5);
