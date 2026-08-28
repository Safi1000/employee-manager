-- ---------------------------------------------------------------------------
-- 0201 — attendance stops when the CLIENT's contract ends, not only when the
--        guard's own contract row does.
--
-- 0152 added the contract window, but it only fired when the employee carried a
-- contract_id. Most guards do not: they are attached to a CLIENT and nothing
-- else (on this database, 316 of 535). For all of them the contract branch was
-- skipped entirely, so a client whose contract ended months ago still had fully
-- markable attendance — which is the hole this closes.
--
-- The fallback is deliberately conservative, because "no data" must never read
-- as "ended":
--   • A client with no contract rows at all is not gated. Nothing is known, so
--     nothing is blocked.
--   • A single open-ended contract (is_infinite, or simply no end_date on file)
--     leaves the client open-ended. Most contracts here carry a null end_date
--     and treating that as expired would lock out the whole roster.
--   • Draft contracts are ignored — not in force yet.
--   • The LATEST end_date across the client's contracts wins, so renewing onto a
--     second contract row extends coverage instead of fighting the old row.
--   • Only the END is enforced. No start date is derived from client coverage:
--     back-marking a period that predates when contracts were first entered is
--     legitimate and must keep working.
--
-- Only this one function changes; attendance_gate() and the enforcement trigger
-- call it, so every write path — the timesheet, Mark All Present, the bulk-mark
-- calendar and the attendance board — picks the rule up unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_window_block_reason(
  p_guard uuid,
  p_date  date
) returns text language plpgsql stable security definer set search_path = public as $$
declare
  e public.employees%rowtype;
  c public.contracts%rowtype;
  v_latest_end  date;
  v_open_ended  boolean;
  v_client_name text;
begin
  select * into e from public.employees where id = p_guard;
  if e.id is null then return 'Guard not found'; end if;

  if e.lifecycle_state = 'archived' then
    return 'Record archived';
  end if;
  if e.join_date is not null and p_date < e.join_date then
    return 'Not employed before ' || to_char(e.join_date, 'DD/MM/YYYY');
  end if;
  if e.termination_date is not null and p_date >= e.termination_date then
    return 'Separated on ' || to_char(e.termination_date, 'DD/MM/YYYY')
           || ' — that date and later cannot be marked';
  end if;
  if e.last_working_day is not null and p_date > e.last_working_day then
    return 'Employment ended ' || to_char(e.last_working_day, 'DD/MM/YYYY');
  end if;

  if e.contract_id is not null then
    select * into c from public.contracts where id = e.contract_id;
  end if;

  if c.id is not null then
    -- The guard is pinned to one contract: that contract is the window.
    if c.start_date is not null and p_date < c.start_date then
      return 'Contract ' || c.contract_code || ' starts ' || to_char(c.start_date, 'DD/MM/YYYY');
    end if;
    if coalesce(c.is_infinite, false) = false
       and c.end_date is not null and p_date > c.end_date then
      return 'Contract ' || c.contract_code || ' ended ' || to_char(c.end_date, 'DD/MM/YYYY');
    end if;
  elsif e.client_id is not null then
    -- No contract of their own: fall back to the client's overall coverage.
    select max(k.end_date),
           bool_or(coalesce(k.is_infinite, false) or k.end_date is null)
      into v_latest_end, v_open_ended
      from public.contracts k
     where k.client_id = e.client_id
       and k.status is distinct from 'draft';

    if v_latest_end is not null
       and coalesce(v_open_ended, false) = false
       and p_date > v_latest_end then
      select name into v_client_name from public.clients where id = e.client_id;
      return 'Contract for ' || coalesce(v_client_name, 'this client')
             || ' ended ' || to_char(v_latest_end, 'DD/MM/YYYY');
    end if;
  end if;

  return null;
end $$;

grant execute on function public.attendance_window_block_reason(uuid, date) to authenticated;
