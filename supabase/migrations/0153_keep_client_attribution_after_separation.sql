-- ---------------------------------------------------------------------------
-- 0153 — A separated guard keeps their client attribution
--
-- Bug: sync_employee_active_client() (trigger trg_deployments_sync_client on
-- public.deployments) resolved employees.client_id from the guard's OPEN
-- posting only:
--
--     select client_id from deployments where guard_id = ... and end_date is null
--
-- record_separation() closes the posting on separation (`set end_date = ...`),
-- which fires this trigger, finds no open posting, and writes client_id = NULL.
-- Result: every fired / resigned / terminated guard lost their client. At the
-- time of writing that is 46 of 47 separated client-category employees, while
-- all 455 active ones still have theirs.
--
-- That breaks the money trail. A guard fired mid-month has attendance and is
-- still owed a partial salary, but with a null client that cost can no longer
-- be attributed to the client it was incurred against, so client-level
-- reporting silently under-counts.
--
-- Fix: when there is no open posting, fall back to the most recent posting's
-- client instead of null. client_id therefore means "currently posted to, or
-- last posted to" — an open posting always wins, so transfers are unaffected.
-- Only the "no open posting" case changes: it used to clear the client, now it
-- remembers it.
-- ---------------------------------------------------------------------------

create or replace function public.sync_employee_active_client()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_guard  uuid;
  v_client uuid;
begin
  v_guard := coalesce(NEW.guard_id, OLD.guard_id);

  -- Prefer the open posting; fall back to the latest closed one so a separation
  -- (or any other posting close) never erases the attribution.
  select d.client_id into v_client
    from public.deployments d
   where d.guard_id = v_guard
   order by (d.end_date is null) desc,   -- open posting first
            d.start_date desc nulls last,
            d.created_at desc
   limit 1;

  -- Never downgrade a known client to null: if the guard has no postings at all
  -- (or the latest one carries no client), keep whatever they already had.
  if v_client is null then
    return null;
  end if;

  update public.employees e
     set client_id = v_client,
         -- Unchanged rule: a genuine client CHANGE drops the per-client display
         -- number so it is reissued for the new client. Staying put keeps it.
         display_number = case when v_client is distinct from e.client_id then null else e.display_number end,
         updated_at = now()
   where e.id = v_guard
     and (e.client_id is distinct from v_client);

  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Backfill the guards the old trigger already cleared, from their most recent
-- posting. Separated staff only — an active guard with a null client is a
-- different situation (never posted) and is left alone.
--
-- display_number is NOT restored: the old trigger nulled it in the same write
-- and the original per-client number is not recoverable. These records keep
-- falling back to their permanent GGS code for display, which is cosmetic.
-- Assigning fresh numbers would burn counter values and renumber people, so
-- that is deliberately left for a human to decide.
-- ---------------------------------------------------------------------------
update public.employees e
   set client_id = last_posting.client_id,
       updated_at = now()
  from (
    select distinct on (d.guard_id)
           d.guard_id, d.client_id
      from public.deployments d
     where d.client_id is not null
     order by d.guard_id,
              (d.end_date is null) desc,
              d.start_date desc nulls last,
              d.created_at desc
  ) as last_posting
 where e.id = last_posting.guard_id
   and e.client_id is null
   and e.lifecycle_state in ('fired', 'terminated', 'left', 'absconded');
