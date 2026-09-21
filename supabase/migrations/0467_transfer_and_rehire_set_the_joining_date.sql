-- 0467 — The joining date follows the posting (user, 2026-09-21).
--
-- DECIDED, by the user, three things:
--
-- 1. A TRANSFER to a new client or site makes the transfer date the joining
--    date. change_category() now writes employees.join_date = the effective date
--    on its client arm (which is also the site-move arm: a site move re-posts to
--    the same client). A move to reliever / office staff is not a client or site
--    transfer and leaves join_date alone.
-- 2. A REHIRE makes the rehire date the joining date. rehire_guard() now writes
--    employees.join_date = p_join_date.
--    "Set joindate directly" — the user chose this knowing the consequence:
--    attendance_window_block_reason() refuses any date before join_date, so
--    days before a transfer or rehire can no longer be marked or corrected, and
--    client_shift_roster() drops the guard for those dates.
-- 3. EDITING a joining date must reach the Daily Attendance Board. The board
--    lists guards from their posting (deployments.start_date <= date), and the
--    posting is opened at the joining date when the guard is hired. Correcting
--    join_date later never moved it: GGS-00559 was entered as joining
--    2029-09-19, corrected to 2026-09-18 on 2026-09-21, and the posting still
--    starts 2029-09-19, so the guard is on no board this year.
--    A BEFORE UPDATE OF join_date trigger now moves the posting that started on
--    the OLD joining date to the new one (and assignment_effective_from with
--    it), unless a posting already starts on the new date — which is what a
--    transfer or rehire has just done, so (1) and (2) never trip it — or the
--    move would overlap an earlier posting.
--
-- BACKFILL. 38 live guards have a joining date before their first posting, and
-- every one had join_date edited. Only 10 are this defect: the posting starts on
-- a joining date the audit log shows was later replaced. The other 28 are guards
-- whose real joining date predates the system (2023 joiners first posted
-- 2026-05-11) and are not moved. A backfill row that enforce_deployment_slot_free
-- refuses (another guard held the slot on the corrected date) is skipped and
-- named in a notice; the live trigger does NOT skip — the person editing the
-- date sees the slot refusal, because a silent skip is the defect being fixed.
--
-- change_category and rehire_guard have been edited by more than one migration,
-- so both are amended by surgery against pg_get_functiondef, anchor asserted
-- exactly once.

-- ── 1. change_category: client arm writes join_date ─────────────────────────
do $$
declare v_def text; v_anchor text := E'       set category = ''client'',\n'; v_n int;
begin
  v_def := pg_get_functiondef('public.change_category(uuid,text,uuid,uuid,date,uuid)'::regprocedure);
  if v_def like '%join_date = v_eff%' then
    raise notice '0467: change_category already sets join_date.';
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0467 REFUSED: change_category anchor found % times, expected 1.', v_n;
  end if;
  execute replace(v_def, v_anchor, v_anchor || E'           join_date = v_eff,\n');
end $$;

-- ── 2. rehire_guard: writes join_date ───────────────────────────────────────
do $$
declare v_def text; v_anchor text := E'    lifecycle_state   = ''active'',\n'; v_n int;
begin
  v_def := pg_get_functiondef('public.rehire_guard(uuid,date,uuid,uuid,uuid)'::regprocedure);
  if v_def like '%join_date         = p_join_date%' then
    raise notice '0467: rehire_guard already sets join_date.';
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0467 REFUSED: rehire_guard anchor found % times, expected 1.', v_n;
  end if;
  execute replace(v_def, v_anchor, v_anchor || E'    join_date         = p_join_date,\n');
end $$;

-- ── 3. An edited joining date moves the posting that started on the old one ─
-- DEFINER, as a trigger: it fires inside a statement that already passed RLS
-- and the permission gate on changing a joining date (enforce_assignment_field_perms).
create or replace function public.join_date_moves_first_posting()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.join_date is null or new.join_date is null or new.join_date = old.join_date then
    return new;
  end if;
  -- A transfer or rehire has just opened a posting on the new joining date.
  if exists (select 1 from public.deployments d
              where d.guard_id = new.id and d.start_date = new.join_date) then
    return new;
  end if;

  update public.deployments d
     set start_date = new.join_date, updated_at = now()
   where d.guard_id = new.id
     and d.start_date = old.join_date
     and (d.end_date is null or d.end_date >= new.join_date)
     and not exists (
       select 1 from public.deployments p
        where p.guard_id = new.id and p.id <> d.id
          and p.start_date < old.join_date
          and coalesce(p.end_date, 'infinity'::date) >= new.join_date);

  if new.assignment_effective_from = old.join_date then
    new.assignment_effective_from := new.join_date;
  end if;
  return new;
end
$$;

drop trigger if exists trg_join_date_moves_first_posting on public.employees;
create trigger trg_join_date_moves_first_posting
  before update of join_date on public.employees
  for each row execute function public.join_date_moves_first_posting();

-- ── 4. Backfill: postings still sitting on a joining date that was replaced ─
do $$
declare r record; v_moved int := 0; v_skipped text[] := '{}';
begin
  for r in
    with firstdep as (
      select distinct on (d.guard_id) d.guard_id, d.id dep_id, d.start_date, d.end_date
        from public.deployments d
       order by d.guard_id, d.start_date, d.id
    )
    select e.id emp_id, e.employee_code, e.join_date, f.dep_id, f.start_date
      from public.employees e
      join firstdep f on f.guard_id = e.id
     where e.join_date < f.start_date
       and (f.end_date is null or f.end_date >= e.join_date)
       and exists (
         select 1 from public.audit_log a
          where a.table_name = 'employees'
            and a.record_id::text = e.id::text
            and a.changes ? 'join_date'
            and (a.changes->'join_date'->>'before')::date = f.start_date)
  loop
    begin
      update public.deployments set start_date = r.join_date, updated_at = now()
       where id = r.dep_id;
      update public.employees set assignment_effective_from = r.join_date
       where id = r.emp_id and assignment_effective_from = r.start_date;
      v_moved := v_moved + 1;
      raise notice '0467: % posting % -> %', r.employee_code, r.start_date, r.join_date;
    exception when check_violation then
      -- enforce_deployment_slot_free: another guard held the slot on the
      -- corrected date. Left where it is and named, not forced.
      v_skipped := v_skipped || (r.employee_code || ' (' || sqlerrm || ')');
    end;
  end loop;
  raise notice '0467: % posting(s) moved to the corrected joining date.', v_moved;
  if cardinality(v_skipped) > 0 then
    raise notice '0467: NOT moved, slot occupied: %', array_to_string(v_skipped, '; ');
  end if;
end $$;

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
