-- 0184: record_separation must not leave a posting that ends before it starts.
--
-- record_separation() closes the open posting with a bare
--
--     end_date = p_last_working_day
--
-- with no floor. When the guard's open posting STARTS AFTER his last working day
-- — a posting keyed in after the separation was decided, or a separation
-- backdated past a recent transfer — the segment ends before it begins.
-- 16 such rows exist, every one of them reason = 'separation'.
--
-- They are harmless to read (start_date <= d AND end_date >= d is never true, so
-- the guard correctly does not appear on any roster) but they are nonsense as
-- records, and they defeat any future check that assumes a segment is a real
-- interval.
--
-- Clamping end_date up to start_date would be WRONG: it would make the segment
-- cover exactly one day and put a separated guard back on the board for it —
-- Shahid Ullah, separated effective 2026-08-01, would reappear on 2026-08-06.
-- A posting that opened after the man had already left never happened, so it is
-- deleted instead. Rows go to the 0183 backup table first.

insert into public.deployments_overlap_backup_0183
select d.*, now(), 'inverted segment (ended before it started) — 0184'
  from public.deployments d
 where d.end_date is not null and d.end_date < d.start_date;

delete from public.deployments
 where end_date is not null and end_date < start_date;

-- Going forward: a posting that begins after the last working day is dropped
-- rather than inverted; everything else closes normally.
create or replace function public.record_separation(
  p_guard            uuid,
  p_reason           separation_reason,
  p_last_working_day date,
  p_termination_date date,
  p_rehire_eligible  boolean,
  p_note             text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  v_new_state employee_lifecycle_state;
begin
  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Guard % not found', p_guard; end if;
  if p_last_working_day is null then raise exception 'Last working day is required'; end if;
  if coalesce(trim(p_note),'') = '' then raise exception 'A separation reason/note is required'; end if;

  v_new_state := case
    when p_reason = 'absconded' then 'absconded'
    when p_reason in ('termination_misconduct','termination_performance') then 'fired'
    else 'left'
  end::employee_lifecycle_state;

  update public.employees set
    separation_reason   = p_reason,
    last_working_day    = p_last_working_day,
    termination_date    = p_termination_date,
    eligible_for_rehire = p_rehire_eligible,
    exit_reason         = p_note,
    exit_date           = coalesce(p_termination_date, p_last_working_day),
    lifecycle_state     = v_new_state,
    updated_at          = now()
  where id = p_guard;

  -- A posting that had not started by the last working day never ran.
  insert into public.deployments_overlap_backup_0183
  select d.*, now(), 'posting began after last working day — record_separation'
    from public.deployments d
   where d.guard_id = p_guard and d.end_date is null and d.start_date > p_last_working_day;

  delete from public.deployments
   where guard_id = p_guard and end_date is null and start_date > p_last_working_day;

  update public.deployments
     set end_date = p_last_working_day, reason = 'separation', updated_at = now()
   where guard_id = p_guard and end_date is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, eligible_for_rehire, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, v_new_state,
     'Separation: ' || p_reason::text, p_rehire_eligible, auth.uid(), p_note);
end $$;

grant execute on function public.record_separation(uuid, separation_reason, date, date, boolean, text) to authenticated;
