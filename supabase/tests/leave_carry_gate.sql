-- supabase/tests/leave_carry_gate.sql
--
-- Guards 0639: carry-forward is the CLIENT's decision, it is DATED, a guard
-- FORFEITS his bank on arrival at a client that does not carry, and a named
-- opening balance replaces the derived one for the period it names.
--
-- WHY THIS SUITE EXISTS
--
-- 0639's own section 4 can only assert the OFF direction, because no client on
-- production carries: every assertion there is equally satisfied by a correct
-- gate and by a gate welded shut. 0639 probes the ON direction once, inside a
-- rolled-back subtransaction; this suite is where that direction is actually
-- specified — dated carry, the forfeit arm, the opening balance, and every
-- refusal.
--
-- THE STANDARD OF PROOF
--
-- Every arm flips real client rows inside the transaction and reads the ledger
-- back through leave_periods_all(). Nothing is restated: the function is the
-- only authority on what it does.
--
-- NON-VACUITY. The chosen guard must EARN something in September — a guard who
-- earns nothing carries nothing, and every equality below would hold at zero,
-- which is the one failure this suite exists to catch. The suite refuses rather
-- than reports a pass if it cannot find one.
--
-- FAILURE LOOKS LIKE SUCCESS, so each refusal arm asserts on the MESSAGE and
-- not on the fact that something raised. An arm that cannot be reached because
-- the running role lacks payroll.edit is reported as NOT DEMONSTRATED, by name.
-- That is not a pass.
--
-- Runs in a transaction and rolls back via the final raise.

do $suite$
declare
  c_expected constant int := 9;
  v_checked  int := 0;
  v_skipped  text[] := '{}';
  v_results  text := '';
  v_fail     int := 0;
  v_co       uuid;
  v_client   uuid;
  v_other    uuid;
  v_guard    uuid;
  v_mover    uuid;
  v_sep_earn int;
  v_sep_close numeric;
  v_open     numeric;
  v_open2    numeric;
  v_msg      text;
  v_state    text;
  v_n        int;
begin
  -- ── the fixture is production, read and flipped inside this transaction ──
  select id into v_co from public.companies
   where exists (select 1 from public.employees e where e.company_id = companies.id)
   order by (select count(*) from public.employees e where e.company_id = companies.id) desc
   limit 1;
  if v_co is null then
    raise exception 'leave_carry_gate: no company with employees — nothing to test against.';
  end if;

  -- The client whose guards demonstrably accrue in September, and that client's
  -- biggest September earner. Both chosen from the ledger, not assumed.
  select e.client_id, count(*) into v_client, v_n
    from public.leave_periods_all(v_co, date '2026-09-30') l
    join public.employees e on e.id = l.employee_id
   where l.period_start = date '2026-09-01' and l.earned > 0 and e.client_id is not null
   group by e.client_id
   order by count(*) desc
   limit 1;
  if v_client is null then
    raise exception 'leave_carry_gate: no client has a guard earning leave in September — the suite would prove nothing at zero.';
  end if;

  select l.employee_id, l.earned, l.closing
    into v_guard, v_sep_earn, v_sep_close
    from public.leave_periods_all(v_co, date '2026-09-30') l
    join public.employees e on e.id = l.employee_id
   where l.period_start = date '2026-09-01' and e.client_id = v_client and l.earned > 0
   order by l.earned desc, l.employee_id
   limit 1;

  -- ── (1) NON-VACUITY: he earns, so there is something that could carry ──
  if v_sep_earn <= 0 then
    v_fail := v_fail + 1;
    v_results := v_results || E'(1) FAIL  chosen guard earns nothing in September\n';
  else
    v_results := v_results || format(E'(1) PASS  non-vacuous: chosen guard earns %s in September\n', v_sep_earn);
  end if;
  v_checked := v_checked + 1;

  -- ── (2) CARRY OFF is the default: October opens at zero ──
  select l.opening into v_open from public.leave_periods_all(v_co, date '2026-10-31') l
   where l.employee_id = v_guard and l.period_start = date '2026-10-01';
  if coalesce(v_open, 0) <> 0 then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(2) FAIL  carry is off yet October opens at %s\n', v_open);
  else
    v_results := v_results || E'(2) PASS  carry off — October opens at zero\n';
  end if;
  v_checked := v_checked + 1;

  -- ── (3) CARRY ON from September: October opens at September's closing ──
  update public.clients set leave_carry_forward = true, leave_carry_start = date '2026-09-01'
   where id = v_client;
  select l.opening into v_open from public.leave_periods_all(v_co, date '2026-10-31') l
   where l.employee_id = v_guard and l.period_start = date '2026-10-01';
  select l.closing into v_sep_close from public.leave_periods_all(v_co, date '2026-10-31') l
   where l.employee_id = v_guard and l.period_start = date '2026-09-01';
  if v_open is null or v_open <= 0 or v_open <> v_sep_close then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(3) FAIL  carry on: October opened at %s, September closed at %s\n', v_open, v_sep_close);
  else
    v_results := v_results || format(E'(3) PASS  carry on — October opens at %s, September''s closing\n', v_open);
  end if;
  v_checked := v_checked + 1;

  -- ── (4) CARRY IS DATED: a start of 1 October does not backdate September ──
  update public.clients set leave_carry_start = date '2026-10-01' where id = v_client;
  select l.opening into v_open from public.leave_periods_all(v_co, date '2026-11-30') l
   where l.employee_id = v_guard and l.period_start = date '2026-10-01';
  select l.opening into v_open2 from public.leave_periods_all(v_co, date '2026-11-30') l
   where l.employee_id = v_guard and l.period_start = date '2026-11-01';
  if coalesce(v_open, 0) <> 0 then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(4) FAIL  start 1 Oct still carried into October (opened %s) — the flag backdated\n', v_open);
  elsif coalesce(v_open2, 0) <= 0 then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(4) FAIL  start 1 Oct did not carry into November (opened %s)\n', v_open2);
  else
    v_results := v_results || format(E'(4) PASS  dated — October opens 0, November opens %s\n', v_open2);
  end if;
  v_checked := v_checked + 1;

  -- ── (5) A NAMED OPENING BALANCE replaces the derived one, for that period ──
  update public.clients set leave_carry_start = date '2026-09-01' where id = v_client;
  update public.employees
     set leave_opening_balance = 6, leave_opening_month = date '2026-10-01',
         leave_opening_reason = 'leave_carry_gate suite', leave_opening_by = v_guard,
         leave_opening_at = now()
   where id = v_guard;
  select l.opening into v_open from public.leave_periods_all(v_co, date '2026-11-30') l
   where l.employee_id = v_guard and l.period_start = date '2026-10-01';
  if coalesce(v_open, -1) <> 6 then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(5) FAIL  opening balance 6 for October, ledger opened at %s\n', v_open);
  else
    v_results := v_results || E'(5) PASS  named opening balance replaces the derived opening\n';
  end if;
  v_checked := v_checked + 1;

  -- ── (6) AN OPENING ON A NON-CARRYING CLIENT IS NOT APPLIED. The RPC refuses
  --        to record one; this asserts the ledger agrees rather than trusting it.
  update public.clients set leave_carry_forward = false, leave_carry_start = null
   where id = v_client;
  select l.opening into v_open from public.leave_periods_all(v_co, date '2026-11-30') l
   where l.employee_id = v_guard and l.period_start = date '2026-10-01';
  if coalesce(v_open, -1) <> 0 then
    v_fail := v_fail + 1;
    v_results := v_results || format(E'(6) FAIL  opening of 6 applied on a non-carrying client (opened %s)\n', v_open);
  else
    v_results := v_results || E'(6) PASS  opening balance ignored where the client does not carry\n';
  end if;
  v_checked := v_checked + 1;
  update public.employees
     set leave_opening_balance = null, leave_opening_month = null, leave_opening_reason = null,
         leave_opening_by = null, leave_opening_at = null
   where id = v_guard;

  -- ── (7) FORFEITS ON ARRIVAL. A guard who stood on two clients in one period
  --        carries only if BOTH carry. Switch one on, leave the other off.
  select l.employee_id into v_mover
    from public.leave_periods_all(v_co, date '2026-11-30') l
   where l.period_start = date '2026-10-01'
     and (select count(distinct k.client_id)
            from public.attendance_records ar
            join public.deployments d on d.guard_id = ar.employee_id
                 and d.start_date <= ar.attendance_date
                 and coalesce(d.end_date, 'infinity'::date) >= ar.attendance_date
            join public.contract_lines cl on cl.id = d.contract_line_id
            join public.contracts k on k.id = cl.contract_id
           where ar.employee_id = l.employee_id
             and ar.attendance_date between date '2026-10-01' and date '2026-10-31'
             and lower(ar.status) in ('present','double_duty','relief_cover')) > 1
   limit 1;
  if v_mover is null then
    v_skipped := v_skipped || 'forfeit-on-arrival: no guard stood on two clients in one period on this data';
    v_results := v_results || E'(7) NOT DEMONSTRATED  no two-client period exists to test the forfeit arm\n';
  else
    -- Everything he stood on, switched ON except one, which stays off.
    update public.clients set leave_carry_forward = true, leave_carry_start = date '2026-09-01'
     where id in (select k.client_id from public.attendance_records ar
                    join public.deployments d on d.guard_id = ar.employee_id
                         and d.start_date <= ar.attendance_date
                         and coalesce(d.end_date, 'infinity'::date) >= ar.attendance_date
                    join public.contract_lines cl on cl.id = d.contract_line_id
                    join public.contracts k on k.id = cl.contract_id
                   where ar.employee_id = v_mover
                     and ar.attendance_date between date '2026-10-01' and date '2026-10-31');
    select l.opening into v_open from public.leave_periods_all(v_co, date '2026-11-30') l
     where l.employee_id = v_mover and l.period_start = date '2026-11-01';
    -- now take ONE of them back off
    select k.client_id into v_other from public.attendance_records ar
      join public.deployments d on d.guard_id = ar.employee_id
           and d.start_date <= ar.attendance_date
           and coalesce(d.end_date, 'infinity'::date) >= ar.attendance_date
      join public.contract_lines cl on cl.id = d.contract_line_id
      join public.contracts k on k.id = cl.contract_id
     where ar.employee_id = v_mover
       and ar.attendance_date between date '2026-10-01' and date '2026-10-31'
     limit 1;
    update public.clients set leave_carry_forward = false, leave_carry_start = null where id = v_other;
    select l.opening into v_open2 from public.leave_periods_all(v_co, date '2026-11-30') l
     where l.employee_id = v_mover and l.period_start = date '2026-11-01';
    if coalesce(v_open2, -1) <> 0 then
      v_fail := v_fail + 1;
      v_results := v_results || format(E'(7) FAIL  one non-carrying client in the period, yet November opened at %s\n', v_open2);
    else
      v_results := v_results || format(E'(7) PASS  forfeits on arrival — carried %s with both on, 0 with one off\n', coalesce(v_open, 0));
    end if;
  end if;
  v_checked := v_checked + 1;

  -- ── (8) CARRY ON WITHOUT A START MONTH IS REFUSED, by name ──
  begin
    update public.clients set leave_carry_forward = true, leave_carry_start = null where id = v_client;
    v_fail := v_fail + 1;
    v_results := v_results || E'(8) FAIL  carry switched on with no start month and was ACCEPTED\n';
  exception when others then
    v_msg := sqlerrm;
    if v_msg not like '%carry_on_needs_a_start%' then
      v_fail := v_fail + 1;
      v_results := v_results || format(E'(8) FAIL  refused for another reason: %s\n', left(v_msg, 80));
    else
      v_results := v_results || E'(8) PASS  carry on with no start month refused by carry_on_needs_a_start\n';
    end if;
  end;
  v_checked := v_checked + 1;

  -- ── (9) A HALF-SET OPENING BALANCE IS REFUSED, by name. The one thing the
  --        constraint exists for: a figure with nobody's name on it.
  begin
    update public.employees set leave_opening_balance = 4, leave_opening_month = date '2026-10-01',
           leave_opening_reason = null, leave_opening_by = null, leave_opening_at = null
     where id = v_guard;
    v_fail := v_fail + 1;
    v_results := v_results || E'(9) FAIL  an opening balance with no reason/by/at was ACCEPTED\n';
  exception when others then
    v_msg := sqlerrm;
    if v_msg not like '%leave_opening_complete%' then
      v_fail := v_fail + 1;
      v_results := v_results || format(E'(9) FAIL  refused for another reason: %s\n', left(v_msg, 80));
    else
      v_results := v_results || E'(9) PASS  half-set opening balance refused by leave_opening_complete\n';
    end if;
  end;
  v_checked := v_checked + 1;

  -- ── set_leave_opening()'s own refusals, reached only with payroll.edit.
  --     Reported by name when the running role cannot reach them.
  begin
    perform public.set_leave_opening(v_guard, 4, date '2026-10-01', '   ');
    v_fail := v_fail + 1;
    v_results := v_results || E'(+) FAIL  set_leave_opening accepted a blank reason\n';
  exception when others then
    v_msg := sqlerrm; v_state := sqlstate;
    if v_state = '42501' then
      v_skipped := v_skipped || 'set_leave_opening validation: ran without payroll.edit';
      v_results := v_results || E'(+) NOT DEMONSTRATED  set_leave_opening needs payroll.edit; this role has none\n';
    elsif v_msg not like '%needs a reason%' then
      v_fail := v_fail + 1;
      v_results := v_results || format(E'(+) FAIL  blank reason refused for another reason: %s\n', left(v_msg, 80));
    else
      v_results := v_results || E'(+) PASS  set_leave_opening refuses a blank reason\n';
    end if;
  end;

  -- ── CANARY: a suite whose silence cannot tell "all passed" from "aborted at
  --    arm 4" is not a harness.
  if v_checked <> c_expected then
    raise exception 'leave_carry_gate CANARY FAILED: % of % arms ran.%', v_checked, c_expected, E'\n' || v_results;
  end if;

  if v_fail > 0 then
    raise exception E'leave_carry_gate FAILED (% of %):\n%', v_fail, v_checked, v_results;
  end if;

  raise exception E'leave_carry_gate: %/% arms passed% — rolling back deliberately\n%',
    v_checked, c_expected,
    case when array_length(v_skipped, 1) is null then ''
         else format(' (%s not demonstrated: %s)', array_length(v_skipped, 1), array_to_string(v_skipped, '; ')) end,
    v_results;
end
$suite$;
