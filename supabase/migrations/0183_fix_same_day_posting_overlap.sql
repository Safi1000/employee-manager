-- 0183: one guard, one posting, one shift — fix the same-day overlap at source.
--
-- THE BUG
--   change_guard_shift() and change_client() close the outgoing segment with
--
--       end_date = greatest(<segment>.start_date, v_eff - 1)
--
--   The greatest() is there to stop end_date landing before start_date. But when
--   the change is effective on the SAME DAY the current segment started —
--   start_date = v_eff — it evaluates to v_eff itself. The outgoing segment is
--   then left ending on the very day the incoming one starts, and BOTH cover
--   that date.
--
--   The attendance board renders one row per segment covering the date, so the
--   guard appears twice. Change his shift again the same day and it is three
--   times, and so on. That is exactly what happened to Mursaleen Khan
--   (GGS-00101): six segments all dated 2026-08-01 — three duplicate Nova
--   Islamabad relief_cover rows and three Nova Charsadda shift_change rows —
--   putting him on Charsadda day, Charsadda night and Islamabad night at once.
--   8 guards are affected on 2026-08-01, across 21 posting rows.
--
--   Migration 0139 cleaned overlaps once but deliberately spared same-day pairs
--   as "legitimate double duty". They are not: double duty is recorded as a
--   second ATTENDANCE row on the date (see 0173), never as a second posting.
--   That exemption is what let this class of overlap survive and recur.
--
-- THE FIX
--   A segment that would have to end before it began never covered a single
--   day. It is an artefact of the edit, not history worth keeping, so it is
--   DELETED rather than left overlapping. Applied both to the existing data and
--   to the three functions that create postings, so it cannot come back.
--
-- Losing rows are copied to deployments_overlap_backup_0183 before deletion, so
-- this is reversible. Attendance records are not touched anywhere in here.

-- ---------------------------------------------------------------------------
-- 0. Backup
-- ---------------------------------------------------------------------------
create table if not exists public.deployments_overlap_backup_0183 (
  like public.deployments including defaults,
  backed_up_at timestamptz not null default now(),
  backup_note  text
);

-- ---------------------------------------------------------------------------
-- 1. Collapse same-day clusters.
--
--    Where a guard holds several segments starting on the SAME date, exactly one
--    survives: the still-open segment if there is one (an open posting is the
--    current truth), otherwise the most recently created. The rest never had a
--    day of their own.
-- ---------------------------------------------------------------------------
with ranked as (
  select d.id, d.guard_id, d.start_date,
         row_number() over (
           partition by d.guard_id, d.start_date
           order by (d.end_date is null) desc, d.created_at desc, d.id
         ) as rn
    from public.deployments d
),
losers as (select id from ranked where rn > 1)
insert into public.deployments_overlap_backup_0183
select d.*, now(), 'same-day duplicate segment'
  from public.deployments d join losers l on l.id = d.id;

with ranked as (
  select d.id,
         row_number() over (
           partition by d.guard_id, d.start_date
           order by (d.end_date is null) desc, d.created_at desc, d.id
         ) as rn
    from public.deployments d
)
delete from public.deployments d
 using ranked r
 where r.id = d.id and r.rn > 1;

-- ---------------------------------------------------------------------------
-- 2. Fix the boundary off-by-one between segments starting on DIFFERENT days.
--
--    e.g. Muhammad Sabir Khan: 2024-05-23 → 2026-08-01 sitting beside a segment
--    opening 2026-08-01. The predecessor should stop on 2026-07-31.
--
--    CLOSED segments only. A handful of guards (Khan Badshah, Muhammad Sadiq
--    Khan) hold an OPEN segment followed by a later-starting closed one — the
--    unique index allows only one open posting each, so closing it here would
--    leave them with none and drop them off every roster from that day on.
--    That contradiction needs a human to say which posting is real, so those
--    rows are left exactly as they are; see the query at the foot of this file.
-- ---------------------------------------------------------------------------
with ordered as (
  select d.id, d.start_date, d.end_date,
         lead(d.start_date) over (partition by d.guard_id order by d.start_date, d.id) as next_start
    from public.deployments d
)
update public.deployments t
   set end_date = o.next_start - 1, updated_at = now()
  from ordered o
 where t.id = o.id
   and o.next_start is not null
   and o.next_start > o.start_date
   and o.end_date is not null
   and o.end_date >= o.next_start;

-- ---------------------------------------------------------------------------
-- 3. Close any posting still open under a separated guard.
--    record_separation() does this, but a posting created AFTER the separation
--    (relief cover keyed in late) slips past it and keeps the man on the roster.
-- ---------------------------------------------------------------------------
update public.deployments d
   set end_date   = greatest(d.start_date, coalesce(e.termination_date, e.last_working_day, e.exit_date)),
       reason     = 'separation',
       updated_at = now()
  from public.employees e
 where e.id = d.guard_id
   and d.end_date is null
   and e.lifecycle_state in ('left','terminated','fired','absconded')
   and coalesce(e.termination_date, e.last_working_day, e.exit_date) is not null;

-- ---------------------------------------------------------------------------
-- 4. Stop it recurring: close-or-delete, never overlap.
-- ---------------------------------------------------------------------------
create or replace function public.change_guard_shift(
  p_guard uuid, p_new_shift text, p_effective_date date default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
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

  -- Close the outgoing segment the day before the change. If that would fall
  -- before it started, the segment never covered a live day — the shift is being
  -- corrected on the same day it was set — so it is removed instead of being
  -- left to overlap its successor. Overlapping is what put one guard on two
  -- sites at once.
  if v_eff - 1 < v_dep.start_date then
    insert into public.deployments_overlap_backup_0183
    select v_dep.*, now(), 'superseded same-day by change_guard_shift';
    delete from public.deployments where id = v_dep.id;
  else
    update public.deployments
       set end_date = v_eff - 1, reason = 'shift_change', updated_at = now()
     where id = v_dep.id;
  end if;

  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason, shift_code)
  values
    (v_company, p_guard, v_dep.client_id,
     (select cl.id from public.contract_lines cl
       where cl.site_id = v_dep.site_id and cl.shift_code::text = p_new_shift limit 1),
     v_dep.site_id, v_eff, 'shift_change', p_new_shift)
  returning id into v_new_id;

  update public.employees set shift = p_new_shift, updated_at = now() where id = p_guard;
  return v_new_id;
end $function$;

create or replace function public.change_client(
  p_guard_id uuid, p_new_client_id uuid,
  p_contract_line_id uuid default null, p_site_id uuid default null,
  p_reason deployment_reason default 'relief_cover', p_effective_date date default null
) returns uuid
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_company uuid;
  v_eff     date;
  v_site    uuid;
  v_dep     record;
  v_new_id  uuid;
begin
  select company_id into v_company from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Guard % not found', p_guard_id; end if;

  v_eff  := coalesce(p_effective_date, current_date);
  v_site := coalesce(p_site_id,
    (select id from public.sites where client_id = p_new_client_id and is_default limit 1));

  select * into v_dep from public.deployments
   where guard_id = p_guard_id and end_date is null
   order by start_date desc limit 1;

  -- Same rule as change_guard_shift: a segment with no live day is deleted, not
  -- left overlapping. Re-posting a guard the same day he was posted is a
  -- correction, and a correction should not leave a second posting behind.
  if v_dep.id is not null then
    if v_eff - 1 < v_dep.start_date then
      insert into public.deployments_overlap_backup_0183
      select v_dep.*, now(), 'superseded same-day by change_client';
      delete from public.deployments where id = v_dep.id;
    else
      update public.deployments
         set end_date = v_eff - 1, updated_at = now()
       where id = v_dep.id;
    end if;
  end if;

  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
  values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, p_reason)
  returning id into v_new_id;

  return v_new_id;
end $function$;

-- ---------------------------------------------------------------------------
-- 5. A lifecycle exit must separate as completely as record_separation does.
--
--    transition_employee_lifecycle() (the Lifecycle panel's exit buttons) sets
--    lifecycle_state and exit_date but never last_working_day, termination_date
--    or the posting close. No record is currently stranded by this — the exits
--    in this database all went through record_separation — but the roster
--    cutoff is computed from those two dates, so a guard exited this way would
--    stay on every future roster. Closing the hole before it is used.
-- ---------------------------------------------------------------------------
create or replace function public.transition_employee_lifecycle(
  p_employee_id uuid, p_to_state public.employee_lifecycle_state,
  p_reason text default null, p_eligible_for_rehire boolean default null,
  p_notes text default null
) returns public.employee_lifecycle_state
language plpgsql security definer set search_path = public as $$
declare
  e record;
  v_is_exit   boolean;
  v_is_rehire boolean;
  v_day date := current_date;
begin
  select * into e from public.employees where id = p_employee_id for update;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
  if e.lifecycle_state = p_to_state then return e.lifecycle_state; end if;
  if not public.lifecycle_transition_allowed(e.lifecycle_state, p_to_state) then
    raise exception 'illegal lifecycle transition % -> %', e.lifecycle_state, p_to_state
      using errcode = '23514';
  end if;

  -- 'fired' and 'absconded' are exits too; the original listed only left/terminated.
  v_is_exit   := p_to_state in ('left','terminated','fired','absconded');
  v_is_rehire := e.lifecycle_state in ('left','terminated','fired','absconded')
                 and p_to_state = 'active';

  if v_is_exit then
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'exit requires a reason' using errcode = '23514';
    end if;
    if p_eligible_for_rehire is null then
      raise exception 'exit requires an explicit eligible-for-rehire decision' using errcode = '23514';
    end if;
  end if;

  if v_is_rehire then
    if e.blacklisted then
      raise exception 'employee is blacklisted and cannot be rehired'
        using errcode = '23514', hint = e.blacklist_reason;
    end if;
    if e.eligible_for_rehire is false then
      raise exception 'employee was marked not eligible for rehire at last exit' using errcode = '23514';
    end if;
  end if;

  update public.employees set
    lifecycle_state     = p_to_state,
    exit_reason         = case when v_is_exit then p_reason else exit_reason end,
    exit_date           = case when v_is_exit then v_day else exit_date end,
    eligible_for_rehire = case when v_is_exit then p_eligible_for_rehire else eligible_for_rehire end,
    rehire_count        = case when v_is_rehire then rehire_count + 1 else rehire_count end,
    -- This panel has no date picker, so the exit is taken as effective today.
    -- Use record_separation() when the real last working day was earlier.
    last_working_day    = case when v_is_rehire then null
                               when v_is_exit then coalesce(last_working_day, v_day)
                               else last_working_day end,
    termination_date    = case when v_is_rehire then null
                               when v_is_exit then coalesce(termination_date, v_day)
                               else termination_date end,
    separation_reason   = case when v_is_rehire then null else separation_reason end,
    updated_at          = now()
  where id = p_employee_id;

  if v_is_exit then
    update public.deployments
       set end_date = greatest(start_date, v_day), reason = 'separation', updated_at = now()
     where guard_id = p_employee_id and end_date is null;
  end if;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_employee_id, e.lifecycle_state, p_to_state, p_reason,
     case when v_is_exit then p_eligible_for_rehire else null end, auth.uid(), p_notes);

  return p_to_state;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Left for human review: guards whose OPEN posting is followed by a
--    later-starting CLOSED one. Step 2 deliberately does not touch these.
--    Run this after applying and decide which posting is the real one.
--
--    select e.display_number, e.full_name, d.start_date, d.end_date,
--           d.shift_code, s.name as site, d.reason
--      from public.deployments d
--      join public.employees e on e.id = d.guard_id
--      left join public.sites s on s.id = d.site_id
--     where d.guard_id in (
--       select o.guard_id from (
--         select guard_id, start_date, end_date,
--                max(start_date) over (partition by guard_id) as last_start
--           from public.deployments) o
--        where o.end_date is null and o.start_date < o.last_start)
--     order by e.full_name, d.start_date;
-- ---------------------------------------------------------------------------
