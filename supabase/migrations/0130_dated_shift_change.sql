-- 0130: Dated shift changes on the posting (§7.5 / §2.4) — additive only.
--
-- Shift becomes a DATED property of the posting so a shift change (like a client
-- change) CLOSES the old segment and OPENS a new one — history is never rewritten
-- in place. Adds deployments.shift_code (+ backfill) and change_guard_shift(),
-- and lets the attendance board read the shift of the posting that actually
-- contains the viewed date instead of the guard's single current shift.
--
-- Nothing is dropped. record_separation / rehire_guard (0128) already close /
-- open postings and gate the roster via the employment window; this only makes
-- the SHIFT of each dated segment explicit.

-- ---------------------------------------------------------------------------
-- 1. deployments.shift_code — the shift this posting segment runs.
-- ---------------------------------------------------------------------------
alter table public.deployments
  add column if not exists shift_code text;

-- Backfill every existing posting with its shift: the posting's contract-line
-- shift where set, else the guard's current employees.shift. No dated shift
-- changes existed before this release, so each guard's segments share one shift —
-- this backfill is faithful (it does not invent history).
update public.deployments d
set shift_code = coalesce(
      (select cl.shift_code::text
         from public.contract_lines cl
        where cl.id = d.contract_line_id and cl.shift_code is not null),
      e.shift,
      'day')
from public.employees e
where e.id = d.guard_id and d.shift_code is null;

-- ---------------------------------------------------------------------------
-- 2. change_guard_shift() — a DATED shift change (§7.5).
--    Closes the current open posting at the day BEFORE the effective date
--    (matching change_client's convention), opens a new posting on the new shift
--    from the effective date (same client + site), and updates the employee's
--    current shift for lists / edit form / exports. Never edits history in place.
-- ---------------------------------------------------------------------------
create or replace function public.change_guard_shift(
  p_guard          uuid,
  p_new_shift      text,
  p_effective_date date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_eff     date;
  v_dep     record;
  v_cur     text;
  v_new_id  uuid;
begin
  select company_id into v_company from public.employees where id = p_guard;
  if v_company is null then raise exception 'Guard % not found', p_guard; end if;
  if coalesce(trim(p_new_shift), '') = '' then raise exception 'New shift is required'; end if;

  v_eff := coalesce(p_effective_date, current_date);

  -- The current open posting supplies client/site continuity.
  select * into v_dep from public.deployments
   where guard_id = p_guard and end_date is null
   order by start_date desc limit 1;
  if v_dep.id is null then
    raise exception 'No active posting to change shift for; rehire the guard first';
  end if;

  v_cur := coalesce(v_dep.shift_code, (select shift from public.employees where id = p_guard));
  if v_cur = p_new_shift then
    raise exception 'Guard is already on the % shift', p_new_shift;
  end if;

  -- Close the current segment the day before the change (never edited in place).
  update public.deployments
     set end_date   = greatest(v_dep.start_date, v_eff - 1),
         reason     = 'shift_change',
         updated_at = now()
   where id = v_dep.id;

  -- Open the new-shift segment from the effective date (same client + site).
  -- contract_line_id resolves to that site's strength line for the new shift
  -- when one exists; the shift is carried explicitly on shift_code regardless.
  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason, shift_code)
  values
    (v_company, p_guard, v_dep.client_id,
     (select cl.id from public.contract_lines cl
        where cl.site_id = v_dep.site_id and cl.shift_code::text = p_new_shift
        limit 1),
     v_dep.site_id, v_eff, 'shift_change', p_new_shift)
  returning id into v_new_id;

  -- Current-state shift (history stays on the dated segments above).
  update public.employees set shift = p_new_shift, updated_at = now() where id = p_guard;

  return v_new_id;
end $$;

grant execute on function public.change_guard_shift(uuid, text, date) to authenticated;
