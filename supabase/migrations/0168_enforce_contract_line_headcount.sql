-- 0168: a contract line could be filled past the headcount it commits.
--
-- The cap was enforced only in the browser — the Assign dialog counted slots
-- before writing, and the Department picker did not count at all. Anything else
-- that set employees.contract_line_id (a script, the dashboard, a screen that
-- forgets to check) walked straight past it. This puts the rule where the data
-- is, so every writer obeys it.
--
-- Per LINE, not per category. A contract can cover several sites, and the
-- category pool spans all of them: Nova bills four sites off one contract, so
-- "GUARD" totalled 37 committed and no single site's post could ever reach it.
-- A line is one post, at one site, on one shift — the thing actually filled.
--
-- Deliberately narrow, so it enforces the rule without freezing ordinary work:
--
--   * Only fires when contract_line_id is SET or CHANGED. Staying on a line is
--     always allowed. Seven lines are over-filled today (MIU Nerian Sharif
--     commits 1 supervisor and holds 39); blocking those rows outright would
--     stop every edit to the people in them, including the moves that fix it.
--   * Only counts assignments live TODAY — Active, and within the assignment
--     window. An inactive or ended assignment frees its slot, matching
--     assignmentActiveOn() in the app.
--   * Moving OFF a line (to null) is never blocked.
--
-- Not covered on purpose: re-activating someone who is already on a full line,
-- because that would collide with routine lifecycle changes on the over-filled
-- lines above.
create or replace function public.enforce_contract_line_headcount()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_committed int;
  v_active    int;
  v_label     text;
begin
  if new.contract_line_id is null then
    return new;
  end if;
  -- Only a move ONTO a line is checked.
  if tg_op = 'UPDATE' and new.contract_line_id is not distinct from old.contract_line_id then
    return new;
  end if;
  -- An assignment that is not live today consumes no slot.
  if new.status <> 'Active' then
    return new;
  end if;
  if new.assignment_effective_from is not null and new.assignment_effective_from > current_date then
    return new;
  end if;
  if new.assignment_effective_to is not null and new.assignment_effective_to < current_date then
    return new;
  end if;

  -- Committed headcount for the line: its own count plus any dated headcount
  -- addendum aimed at it, floored at 0. Mirrors effectiveCommittedForLine().
  select
    greatest(0, l.committed_count + coalesce((
      select sum(case a.change_type::text
                   when 'ADD_HEADCOUNT'    then  abs(coalesce(a.count_delta, 0))
                   when 'REDUCE_HEADCOUNT' then -abs(coalesce(a.count_delta, 0))
                   else 0
                 end)
      from public.contract_addendums a
      where a.contract_line_id = l.id
        and a.effective_from <= current_date
    ), 0)),
    coalesce(nullif(btrim(l.label), ''), l.category::text)
      || coalesce(' (' || l.shift_code::text || ')', '')
  into v_committed, v_label
  from public.contract_lines l
  where l.id = new.contract_line_id;

  -- Line vanished (or a race deleted it): nothing to measure against.
  if v_committed is null then
    return new;
  end if;

  select count(*)
  into v_active
  from public.employees e
  where e.contract_line_id = new.contract_line_id
    and e.id <> new.id
    and e.status = 'Active'
    and (e.assignment_effective_from is null or e.assignment_effective_from <= current_date)
    and (e.assignment_effective_to is null or e.assignment_effective_to >= current_date);

  if v_active >= v_committed then
    raise exception
      '% is full: the contract commits % and % % already in it. Raise the committed count, or add an addendum, before assigning anyone else.',
      v_label, v_committed, v_active,
      case when v_active = 1 then 'is' else 'are' end
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

-- A trigger function needs no EXECUTE grant to fire, but PostgREST exposes
-- anything executable as /rest/v1/rpc/<name>. Calling it directly errors out
-- ("trigger functions can only be called as triggers"), so it is not a hole —
-- but it should not be on the public API surface either.
revoke execute on function public.enforce_contract_line_headcount() from public, anon, authenticated;

drop trigger if exists trg_enforce_contract_line_headcount on public.employees;
create trigger trg_enforce_contract_line_headcount
before insert or update of contract_line_id on public.employees
for each row execute function public.enforce_contract_line_headcount();
