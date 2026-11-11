-- 0648: Rehire into office staff.
--
-- rehire_guard() can only rehire onto a CLIENT: it requires p_client_id, opens
-- a deployment, and leaves category as it was. A separated guard who comes
-- back to work in the office therefore had no path at all — Add Employee
-- refuses the duplicate CNIC and says "use Rehire", and Rehire offers only
-- clients. Found on Usman Sadiq (GGS-00052), 11 Nov 2026, whose record was
-- archived twice that morning trying to get round it.
--
-- This adds a SEPARATE function rather than a branch inside rehire_guard:
-- rehire_guard has been edited by 0131, 0376, 0467 and 0629, so it has no
-- canonical file and may only be amended by surgery. A new function has one
-- author and nothing to drift from.
--
-- What the office rehire does, matching every existing office_staff row
-- (no client, no contract, no posting, no display number):
--   category = office_staff; client/contract/line/location/display cleared;
--   lifecycle active (status follows via trg_emp_sync_status); join_date and
--   assignment_effective_from = the rehire date; separation fields cleared;
--   rehire_count + 1; any lingering open posting closed; lifecycle event logged.
-- Same permanent code (guard_code / employee_code are untouched).
--
-- Refuses: not separated (incl. 'archived' — the roster treats archive as
-- final, and this does not reopen that), eligible_for_rehire = false,
-- blacklisted, join date on or before the last working day.
--
-- DEFERRED: rehire_guard's 0629 rule (starting again within 7 days of the last
-- working day is a MOVE, use Transfer) is NOT applied here, because Transfer
-- cannot move anyone into the office either, so the refusal would point at a
-- door that does not exist. If the answer is that a guard→office move inside
-- a week should keep the joining date, the change is: add the same 7-day check
-- and give Transfer an office_staff destination.
--
-- Salary is set by the caller afterwards via set_employee_salary, exactly as
-- the client rehire does.

create or replace function public.rehire_to_office_staff(
  p_guard     uuid,
  p_join_date date,
  p_branch_id uuid default null
) returns void
language plpgsql
set search_path to 'public'
as $function$
declare
  e public.employees%rowtype;
  v_rows int;
begin
  -- Permission first, same key as rehire_guard (a direct write to employees).
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('employees.edit');
  end if;

  if p_guard is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_guard));
  end if;
  if p_branch_id is not null then
    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));
  end if;

  if p_join_date is null then
    raise exception 'A rehire needs a joining date' using errcode = '23502';
  end if;

  select * into e from public.employees where id = p_guard for update;
  if e.id is null then raise exception 'Employee % not found', p_guard; end if;

  if e.lifecycle_state::text not in ('terminated', 'fired', 'left', 'absconded') then
    raise exception '% is %, not separated. Only someone who has left can be rehired. Nothing has been recorded.',
      e.full_name, e.lifecycle_state using errcode = '23514';
  end if;
  if e.eligible_for_rehire is false then
    raise exception 'Guard is not eligible for rehire (marked at last separation)';
  end if;
  if e.blacklisted then
    raise exception 'Guard is blacklisted and cannot be rehired';
  end if;
  if e.last_working_day is not null and p_join_date <= e.last_working_day then
    raise exception '% last worked on %; the rehire date % must come after it. Nothing has been recorded.',
      e.full_name, to_char(e.last_working_day, 'DD Mon YYYY'), to_char(p_join_date, 'DD Mon YYYY')
      using errcode = '23514';
  end if;

  update public.employees set
    category                  = 'office_staff',
    client_id                 = null,
    contract_id               = null,
    contract_line_id          = null,
    location_id               = null,
    display_number            = null,
    branch_id                 = coalesce(p_branch_id, branch_id),
    lifecycle_state           = 'active',
    join_date                 = p_join_date,
    assignment_effective_from = p_join_date,
    assignment_effective_to   = null,
    last_working_day          = null,
    termination_date          = null,
    separation_reason         = null,
    exit_date                 = null,
    exit_reason               = null,
    rehire_count              = rehire_count + 1,
    updated_at                = now()
  where id = p_guard;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Rehire into office staff updated % rows for %, expected 1. Nothing has been recorded.', v_rows, p_guard;
  end if;

  -- Office staff hold no posting; close any lingering open one (legacy paths).
  update public.deployments
     set end_date   = greatest(start_date, p_join_date - 1),
         reason     = 'separation',
         updated_at = now()
   where guard_id = p_guard and end_date is null;

  insert into public.employee_lifecycle_events
    (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  values
    (e.company_id, p_guard, e.lifecycle_state, 'active',
     'Rehire into office staff (stint #' || (e.rehire_count + 1) || ')', auth.uid(), null);
end $function$;

comment on function public.rehire_to_office_staff(uuid, date, uuid) is
  '0648: rehire a separated employee into office staff (no client/posting). Same permanent code. '
  'Refuses archived, not-eligible, blacklisted, and dates on/before the last working day. '
  'DEFERRED: whether the 0629 7-day "that is a move" rule should apply to guard→office.';
