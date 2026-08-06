-- 0171: let the dashboard's Live activity feed actually be live.
--
-- The feed's panel says "live" and pulses a green dot, but it was only ever a
-- snapshot taken at page load, rotated on a 2.6-second timer so old rows slid
-- back in at the top pretending to be new. Nothing arriving on the server ever
-- reached an open dashboard.
--
-- Realtime had NO tables in its publication, so a subscription would have
-- connected happily and received nothing forever. These three are what the feed
-- is built from.
--
-- Realtime applies RLS to postgres_changes, so a subscriber still only sees
-- rows their policies allow — adding a table here does not widen access.
alter publication supabase_realtime add table public.invoice_payments;
alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.important_dates;
