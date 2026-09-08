-- 0408 — a new posting cannot begin while the slot is still filled.
--
-- Fire a guard on the 5th and their deployment keeps the post through the 5th
-- (record_separation sets deployments.end_date = last_working_day). A replacement
-- must therefore start AFTER that — you cannot have two people standing in a
-- one-slot post on the same day. But nothing enforced it: the only headcount
-- guard (enforce_contract_line_headcount) counts as-of CURRENT_DATE off
-- employees.status, which cannot see who was active on a past date, so a new hire
-- backdated to the 3rd or 4th slipped straight in.
--
-- deployments holds the date ranges, so the check belongs here. On a posting that
-- is (re)pointed onto a contract line — or whose start moves earlier — refuse if
-- OTHER guards already cover its start_date up to the line's committed headcount.
-- Same-guard segments are excluded (a shift change re-segments one guard's own
-- post; that is not a second person), and headcount counts distinct guards.
--
-- ponytail: checks only the new start_date, which is the tightest point for an
-- open-ended posting (existing covers only thin out as time passes). It does not
-- catch two FUTURE-dated postings that overlap only later — the same blind spot
-- enforce_contract_line_headcount already has; add an interval scan if that ever
-- bites.
create or replace function public.enforce_deployment_slot_free()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_committed int;
  v_covering  int;
  v_label     text;
  v_start     date := new.start_date;
begin
  if new.contract_line_id is null then return new; end if;
  -- Only when the posting lands on a line or its start is pulled EARLIER. A start
  -- pushed later, or an unrelated column edit, only reduces overlap — skip it.
  if tg_op = 'UPDATE'
     and new.contract_line_id is not distinct from old.contract_line_id
     and new.start_date >= old.start_date then
    return new;
  end if;

  -- Committed headcount as of the joining date (addendums in force by then).
  select greatest(0, l.committed_count + coalesce((
      select sum(case a.change_type::text
                   when 'ADD_HEADCOUNT'    then  abs(coalesce(a.count_delta, 0))
                   when 'REDUCE_HEADCOUNT' then -abs(coalesce(a.count_delta, 0))
                   else 0
                 end)
        from public.contract_addendums a
       where a.contract_line_id = l.id
         and a.effective_from <= v_start), 0)),
     coalesce(nullif(btrim(l.label), ''), l.category::text)
       || coalesce(' (' || l.shift_code::text || ')', '')
    into v_committed, v_label
    from public.contract_lines l
   where l.id = new.contract_line_id;

  if v_committed is null then return new; end if;

  -- Distinct OTHER guards whose posting on this line covers the joining date.
  select count(distinct d.guard_id)
    into v_covering
    from public.deployments d
   where d.contract_line_id = new.contract_line_id
     and d.guard_id <> new.guard_id
     and d.start_date <= v_start
     and (d.end_date is null or d.end_date >= v_start);

  if v_covering >= v_committed then
    raise exception
      'The joining date % is before this post is free: % already fills all % committed slot(s) on that day. Pick a date after the previous holder''s last working day.',
      to_char(v_start, 'DD Mon YYYY'), v_label, v_committed
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_enforce_deployment_slot_free on public.deployments;
create trigger trg_enforce_deployment_slot_free
  before insert or update on public.deployments
  for each row execute function public.enforce_deployment_slot_free();

-- The new function is an argument-less trigger — no tenant uuid parameter — so it
-- introduces no gap. Assert the detector still reads clean, as every migration must.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
