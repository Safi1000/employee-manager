-- 0457 — The two headcount caps count per (contract, category, site) across
-- shifts, not per line.
--
-- 0450 settled the model: the committed TOTAL for a (contract, category, site)
-- is the commercial term; the day/night SPLIT is operational (sum-invariant,
-- redistributable via set_shift_split). The two slot triggers never got that
-- memo — they still capped each shift line on its own committed_count. That is
-- why "Guard" shows as "Guard (day)" and "Guard (night)" with separate X/Y
-- counts, and why a night line reading 9/10 in the modal fought 13 open night
-- deployments: the UI counted one thing, the trigger another.
--
-- This makes both triggers count the department at the site: committed is summed
-- across every shift line of the (contract, category, site) group, and occupancy
-- is counted across every one of those lines. Day/night becomes purely the
-- guard's shift attribute. The Assign modal is rewired in the same sitting to
-- show one "Guard · X/Y" row.
--
-- Restated from the LIVE definitions (fetched via pg_get_functiondef), not from
-- an old file copy — every existing guard clause (tg_op skips, status/effective
-- window checks) is preserved; only the committed calc, the occupancy count and
-- the label lose their per-shift narrowing.
--
-- NB numbering: the recorded row `ggs_cash_in_hand_is_restated_to_the_counted_
-- position` (20260916120447) applied after 0455 has no repo file — a real
-- ledger drift owed the 0456 slot. This file takes 0457 to leave it room.

-- ── enforce_deployment_slot_free (BEFORE trigger on deployments) ─────────────
create or replace function public.enforce_deployment_slot_free()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_committed int;
  v_covering  int;
  v_label     text;
  v_start     date := new.start_date;
  v_contract  uuid;
  v_category  text;
  v_site      uuid;
begin
  if new.contract_line_id is null then return new; end if;
  -- Only when the posting lands on a line or its start is pulled EARLIER. A start
  -- pushed later, or an unrelated column edit, only reduces overlap — skip it.
  if tg_op = 'UPDATE'
     and new.contract_line_id is not distinct from old.contract_line_id
     and new.start_date >= old.start_date then
    return new;
  end if;

  -- Which (contract, category, site) group this line belongs to. The label is
  -- the department name only — no shift suffix, because the cap is the whole
  -- category at this site.
  select l.contract_id, l.category::text, l.site_id,
         coalesce(nullif(btrim(l.label), ''), l.category::text)
    into v_contract, v_category, v_site, v_label
    from public.contract_lines l
   where l.id = new.contract_line_id;

  if v_contract is null then return new; end if;

  -- Committed headcount for the WHOLE category at this site, across shifts, as of
  -- the joining date (addendums in force by then). Clamp each line at zero before
  -- summing so one line's REDUCE cannot subsidise another.
  select sum(greatest(0, l.committed_count + coalesce((
      select sum(case a.change_type::text
                   when 'ADD_HEADCOUNT'    then  abs(coalesce(a.count_delta, 0))
                   when 'REDUCE_HEADCOUNT' then -abs(coalesce(a.count_delta, 0))
                   else 0
                 end)
        from public.contract_addendums a
       where a.contract_line_id = l.id
         and a.effective_from <= v_start), 0)))
    into v_committed
    from public.contract_lines l
   where l.contract_id = v_contract
     and l.category::text = v_category
     and l.site_id is not distinct from v_site;

  if v_committed is null then return new; end if;

  -- Distinct OTHER guards posted to ANY shift line of this category+site whose
  -- posting covers the joining date.
  select count(distinct d.guard_id)
    into v_covering
    from public.deployments d
    join public.contract_lines l on l.id = d.contract_line_id
   where l.contract_id = v_contract
     and l.category::text = v_category
     and l.site_id is not distinct from v_site
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
end $function$;

-- ── enforce_contract_line_headcount (BEFORE trigger on employees) ────────────
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
  v_contract  uuid;
  v_category  text;
  v_site      uuid;
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

  select l.contract_id, l.category::text, l.site_id,
         coalesce(nullif(btrim(l.label), ''), l.category::text)
    into v_contract, v_category, v_site, v_label
    from public.contract_lines l
   where l.id = new.contract_line_id;

  if v_contract is null then
    return new;
  end if;

  -- Committed for the whole category at this site, across shifts, today.
  select sum(greatest(0, l.committed_count + coalesce((
      select sum(case a.change_type::text
                   when 'ADD_HEADCOUNT'    then  abs(coalesce(a.count_delta, 0))
                   when 'REDUCE_HEADCOUNT' then -abs(coalesce(a.count_delta, 0))
                   else 0
                 end)
      from public.contract_addendums a
      where a.contract_line_id = l.id
        and a.effective_from <= current_date
    ), 0)))
  into v_committed
  from public.contract_lines l
  where l.contract_id = v_contract
    and l.category::text = v_category
    and l.site_id is not distinct from v_site;

  if v_committed is null then
    return new;
  end if;

  -- Occupants across every shift line of this category+site, live today.
  select count(*)
  into v_active
  from public.employees e
  join public.contract_lines l on l.id = e.contract_line_id
  where l.contract_id = v_contract
    and l.category::text = v_category
    and l.site_id is not distinct from v_site
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

-- ── tenant-guard assertion ───────────────────────────────────────────────────
-- Both are SECURITY DEFINER trigger functions, not directly executable by
-- authenticated, so they are outside tenant_guard_gaps()'s scan set (it inspects
-- only functions authenticated can call). The signatures are unchanged. Assert
-- the detector stays empty so this migration cannot have opened a gap.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0457 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
