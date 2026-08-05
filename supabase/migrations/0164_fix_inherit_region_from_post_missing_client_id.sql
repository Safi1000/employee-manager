-- 0164: post_orders could never be inserted into.
--
-- inherit_region_from_post() is shared by four tables: daily_ok_reports,
-- supervisor_visits, no_show_events and post_orders. The first three carry a
-- client_id column; post_orders does NOT. Reading new.client_id therefore raised
--   record "new" has no field "client_id"
-- on EVERY insert into post_orders, so the table was unusable — writing a post
-- order always failed.
--
-- Read the column through to_jsonb(new) instead, so a table that lacks it simply
-- contributes nothing to the coalesce rather than aborting the insert. The
-- resolution order is unchanged for the three tables that do have it.
create or replace function public.inherit_region_from_post()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_client uuid;
begin
  v_client := nullif(to_jsonb(new) ->> 'client_id', '')::uuid;
  new.branch_id := coalesce(
    public.region_for_post(new.post_id),
    public.region_for_client(v_client),
    public.head_office_region(new.company_id));
  return new;
end;
$function$;
