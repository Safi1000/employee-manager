-- 0163: MIU — put each guard on the site they actually work at.
--
-- ALREADY APPLIED to production on 2026-08-04. Kept as the record of the change,
-- and written to be safely re-runnable (it only writes where the site differs).
--
-- WHY
--   All 44 of MIU's guards sat on the default site "MIU Nerian Sharif", though
--   they work at three different places.
--
-- WHAT MOVES
--   deployments.site_id on the OPEN posting only. No posting is closed or
--   reopened, no dates change, no marked attendance is altered, and contract
--   lines / shift definitions are untouched.
--
-- THE MAPPING — confirmed by the user, NOT derived from names
--   Unlike Nova (0162), MIU's location names do not match its site names, so
--   nothing here could be matched automatically:
--     "MOTH MIRPUR"   -> "MIMC/MOTH Mirpur"   (site name carries an extra prefix)
--     "Nerian Sharif" -> "MIU Nerian Sharif"  (already correct; no-op)
--   Then one deliberate exception, applied AFTER the rules above so it wins:
--     Abdul Tanvir (MIU 001) -> "MIU Camp office"
--   His location is Nerian Sharif, so the rule would otherwise have put him back
--   on the wrong site. Order matters here.
--
-- LEFT ALONE ON PURPOSE
--   4 guards (nos. 44-47, Kashmir Branch) have no location recorded. They stay on
--   MIU Nerian Sharif, where they already were, until someone says where they go.

do $$
declare
  v_client uuid;
  v_moved  int;
  v_one    int;
begin
  select id into v_client from public.clients where name = 'MIU';
  if v_client is null then
    raise exception 'Client "MIU" not found — nothing changed.';
  end if;

  with map as (
    select l.id as location_id, s.id as site_id
    from (values
      ('moth mirpur',   'mimc/moth mirpur'),
      ('nerian sharif', 'miu nerian sharif')
    ) as pair(location_name, site_name)
    join public.locations l on lower(btrim(l.name)) = pair.location_name
    join public.sites s     on s.client_id = v_client
                           and lower(btrim(s.name)) = pair.site_name
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

  -- The one exception, last, so it is not undone by the rule above.
  update public.deployments d
     set site_id = s.id
    from public.employees e, public.sites s
   where e.id = d.guard_id
     and e.display_number = 1
     and s.client_id = v_client
     and lower(btrim(s.name)) = 'miu camp office'
     and d.client_id = v_client
     and d.end_date is null
     and d.site_id is distinct from s.id;
  get diagnostics v_one = row_count;

  raise notice 'MIU: % guard(s) moved by location, % moved to the camp office.', v_moved, v_one;
end $$;
