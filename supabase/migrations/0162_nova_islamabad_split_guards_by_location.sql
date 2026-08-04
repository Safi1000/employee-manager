-- 0162: Nova Group — put each guard on the site matching their location.
--
-- ALREADY APPLIED to production on 2026-08-04. Kept here as the record of the
-- change, and written to be safely re-runnable (it only writes where the site
-- actually differs).
--
-- WHY
--   All 82 of Nova Group's guards sat on the default site "Nova Islamabad",
--   even though they work at four different places. The locations already
--   recorded on the employees say where each one actually is.
--
-- WHAT MOVES
--   deployments.site_id on the OPEN posting (end_date is null). That is the only
--   place a guard's site is recorded — employees has no site column — and it is
--   what Assignments & Pay and the attendance board read. No posting is closed
--   or reopened, no dates change, no marked attendance is altered, and contract
--   lines / shift definitions are deliberately untouched.
--
-- THE MATCH
--   Location name -> site name, ignoring case. Three of the four matched on name
--   alone. The fourth did not: the location is spelt "Nova Charassaadda" and the
--   site "Nova Charsadda". It is plainly the same place, so it is mapped by hand
--   below rather than left behind.
--
-- LEFT ALONE ON PURPOSE
--   24 guards have no location recorded at all. They stay on Nova Islamabad,
--   where they already were. Their branch is ISB/RWP, which hints at Islamabad,
--   but branch is our own office, not the client's site — that is not good enough
--   to post someone by, so they are left for a human to confirm.

do $$
declare
  v_client uuid;
  v_moved  int;
begin
  select id into v_client from public.clients where name = 'Nova Group';
  if v_client is null then
    raise exception 'Client "Nova Group" not found — nothing changed.';
  end if;

  with alias(location_name, site_name) as (
    -- The one location whose spelling does not match its site.
    values ('nova charassaadda', 'nova charsadda')
  ),
  map as (
    select l.id as location_id, s.id as site_id
    from public.locations l
    join alias a on a.location_name = lower(btrim(l.name))
    join public.sites s on s.client_id = v_client
                       and lower(btrim(s.name)) = a.site_name
    union
    select l.id, s.id
    from public.locations l
    join public.sites s on s.client_id = v_client
                       and lower(btrim(s.name)) = lower(btrim(l.name))
  )
  update public.deployments d
     set site_id = m.site_id
    from public.employees e, map m
   where e.id = d.guard_id
     and e.location_id = m.location_id
     and d.client_id = v_client
     and d.end_date is null
     and d.site_id is distinct from m.site_id;
  get diagnostics v_moved = row_count;

  raise notice 'Nova Group: % guard(s) moved onto their location''s site.', v_moved;
end $$;
