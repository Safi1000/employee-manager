-- 0464 — a shift change keeps the guard on his own department's line.
--
-- THE DEFECT. change_guard_shift closes the open posting and opens a new one on
--   (select cl.id from contract_lines cl
--     where cl.site_id = v_dep.site_id and cl.shift_code = p_new_shift limit 1)
-- — the FIRST line at the site with that shift, of ANY category. At a site with
-- Guard, Supervisor and Assistant Supervisor lines, a shift change could land a
-- guard on the Supervisor line or a supervisor on a Guard line.
--
-- Found from Nova Charsadda reading "Guard · 9/10 filled" while
-- enforce_deployment_slot_free refused a 10th guard as full. GGS-00008 Niaz Ali
-- is the site's Assistant Supervisor (employee row, and every posting up to
-- 31 Aug); his 1 Sep shift change re-posted him on a GUARD line. The screen
-- counts him by employees.contract_line_id (Asst Supervisor → 9 guards), the
-- trigger by his posting (Guard → 10). Company-wide the same call put five
-- MIMC/MOTH Mirpur guards on the Supervisor line — six open postings in all.
--
-- THE FIX.
--   1. change_guard_shift — amended by SURGERY against the live definition (six
--      migrations have edited it; no file holds its true text). The new line is
--      the same contract, site and CATEGORY as the posting being closed; the
--      shift only chooses between that category's lines, and if none carries the
--      new shift the guard stays on his current line.
--   2. The six open postings whose line's category differs from the employee's
--      own line are moved to their category's line at the same site, preferring
--      the posting's shift. Capacity checked before writing: Charsadda Asst
--      Supervisor 0/1, Mirpur Guard 19/25 + 5. The slot trigger re-checks each
--      move (the line changes), so an over-cap move would refuse, not slip in.
do $$
declare
  v_def text; v_new text; v_n int;
  v_pat text := '\(select cl\.id from public\.contract_lines cl\s+where cl\.site_id = v_dep\.site_id and cl\.shift_code::text = p_new_shift limit 1\)';
  v_repl text := 'coalesce(
       (select cl.id from public.contract_lines cl
          join public.contract_lines cur on cur.id = v_dep.contract_line_id
         where cl.contract_id = cur.contract_id
           and cl.site_id is not distinct from cur.site_id
           and cl.category = cur.category
         order by (cl.shift_code::text = p_new_shift) desc nulls last, (cl.id = cur.id) desc
         limit 1),
       v_dep.contract_line_id)';
begin
  v_def := pg_get_functiondef('public.change_guard_shift(uuid,text,date)'::regprocedure);
  if v_def like '%cl.category = cur.category%' then
    raise notice '0464: change_guard_shift already keeps the category; skipped.';
  else
    select count(*) into v_n from regexp_matches(v_def, v_pat, 'g');
    if v_n <> 1 then
      raise exception '0464 REFUSED: change_guard_shift line-lookup anchor found % times, expected 1.', v_n;
    end if;
    v_new := regexp_replace(v_def, v_pat, v_repl);
    execute v_new;
  end if;
end $$;

do $$
declare v_moved int; v_bad int;
begin
  create temporary table t0464 on commit drop as
  select d.id as dep_id,
         (select cl.id from public.contract_lines cl
           where cl.contract_id = el.contract_id
             and cl.site_id is not distinct from d.site_id
             and cl.category = el.category
           order by (cl.shift_code::text = d.shift_code) desc nulls last, (cl.id = el.id) desc
           limit 1) as to_line
  from public.deployments d
  join public.employees e       on e.id = d.guard_id
  join public.contract_lines dl on dl.id = d.contract_line_id
  join public.contract_lines el on el.id = e.contract_line_id
  where d.end_date is null
    and e.lifecycle_state in ('active','on_leave')
    and dl.category <> el.category;

  if exists (select 1 from t0464 where to_line is null) then
    raise exception '0464 REFUSED: a misplaced posting has no line of its own category at its site.';
  end if;

  update public.deployments d set contract_line_id = t.to_line
  from t0464 t where d.id = t.dep_id;
  get diagnostics v_moved = row_count;

  -- The thing that can break: an open posting still on another category's line.
  select count(*) into v_bad
  from public.deployments d
  join public.employees e       on e.id = d.guard_id
  join public.contract_lines dl on dl.id = d.contract_line_id
  join public.contract_lines el on el.id = e.contract_line_id
  where d.end_date is null and e.lifecycle_state in ('active','on_leave')
    and dl.category <> el.category;
  if v_bad <> 0 then
    raise exception '0464 REFUSED: % open posting(s) still on another department''s line.', v_bad;
  end if;

  raise notice '0464: % posting(s) moved back to their own department''s line.', v_moved;
end $$;

-- The tenant guard assertion required of every migration.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0464 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
