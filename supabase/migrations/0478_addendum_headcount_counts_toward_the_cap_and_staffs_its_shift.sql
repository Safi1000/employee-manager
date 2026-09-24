-- 0478 — Headcount added by addendum counts toward the staffing cap, and a
-- site an addendum staffs gets its shift.
--
-- 0477 made ADD_HEADCOUNT its own record (contract_line_id null, carrying
-- category / site_id / shift_code). Two things still only looked at lines:
--
-- 1. THE CAP. enforce_contract_line_headcount and enforce_deployment_slot_free
--    sum committed for (contract, category, site) from contract_lines plus the
--    addendums aimed AT those lines. An addendum with no line was invisible,
--    so Nova Islamabad's +1 Guard (from 2026-09-20) left the cap at 17 and the
--    18th guard was refused as "full". Both now add the line-less addendums of
--    the same contract / category / site in force on the date they judge
--    (today / the joining date). Legacy line-less addendums with site_id null
--    (CON-0023: +1 then −1 Guard, net 0) match the contract-wide group, which
--    is what they always meant.
--
-- 2. THE SHIFT. shift_definitions came only from contract lines, in
--    save_contract. A site opened by addendum (it has no line) had no shift at
--    all, and save_contract's clean-up would delete one that an addendum was
--    the only thing staffing. Now: a trigger on contract_addendums creates the
--    (site, shift) definition with save_contract's own default hours, and
--    save_contract's delete also spares a shift an addendum staffs.
--
-- All three functions have more than one author (the caps: 0168, 0408, 0415,
-- 0457, 0463, 0464, 0467; save_contract: 0469 and later), so each is amended
-- by SURGERY against pg_get_functiondef, with its anchor asserted to appear
-- exactly once, and skipped when the 0478 marker is already there (replay).

do $mig$
declare
  v_def  text;
  v_new  text;
  v_anchor text;
  v_ins  text;
  v_n    int;
begin
  -- ── 1a. enforce_contract_line_headcount (judges today) ──────────────────────
  v_def := pg_get_functiondef('public.enforce_contract_line_headcount'::regproc);
  if position('0478:' in v_def) = 0 then
    v_anchor := E'  if v_committed is null then\n    return new;\n  end if;\n';
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception '0478: enforce_contract_line_headcount anchor found % times, expected 1', v_n;
    end if;
    v_ins := E'\n  -- 0478: headcount added by addendum with no line of its own (0477) belongs\n'
          || E'  -- to this contract / category / site too.\n'
          || E'  v_committed := greatest(0, v_committed + coalesce((\n'
          || E'      select sum(case a.change_type::text\n'
          || E'                   when ''ADD_HEADCOUNT''    then  abs(coalesce(a.count_delta, 0))\n'
          || E'                   when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0))\n'
          || E'                   else 0\n'
          || E'                 end)\n'
          || E'        from public.contract_addendums a\n'
          || E'       where a.contract_id = v_contract\n'
          || E'         and a.contract_line_id is null\n'
          || E'         and a.category::text = v_category\n'
          || E'         and a.site_id is not distinct from v_site\n'
          || E'         and a.effective_from <= current_date), 0));\n';
    v_new := replace(v_def, v_anchor, v_anchor || v_ins);
    execute v_new;
  end if;

  -- ── 1b. enforce_deployment_slot_free (judges the joining date) ─────────────
  v_def := pg_get_functiondef('public.enforce_deployment_slot_free'::regproc);
  if position('0478:' in v_def) = 0 then
    v_anchor := E'  if v_committed is null then return new; end if;\n';
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception '0478: enforce_deployment_slot_free anchor found % times, expected 1', v_n;
    end if;
    v_ins := E'\n  -- 0478: headcount added by addendum with no line of its own (0477),\n'
          || E'  -- in force by the joining date.\n'
          || E'  v_committed := greatest(0, v_committed + coalesce((\n'
          || E'      select sum(case a.change_type::text\n'
          || E'                   when ''ADD_HEADCOUNT''    then  abs(coalesce(a.count_delta, 0))\n'
          || E'                   when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0))\n'
          || E'                   else 0\n'
          || E'                 end)\n'
          || E'        from public.contract_addendums a\n'
          || E'       where a.contract_id = v_contract\n'
          || E'         and a.contract_line_id is null\n'
          || E'         and a.category::text = v_category\n'
          || E'         and a.site_id is not distinct from v_site\n'
          || E'         and a.effective_from <= v_start), 0));\n';
    v_new := replace(v_def, v_anchor, v_anchor || v_ins);
    execute v_new;
  end if;

  -- ── 2a. save_contract: do not delete a shift an addendum staffs ────────────
  v_def := pg_get_functiondef('public.save_contract'::regproc);
  if position('0478:' in v_def) = 0 then
    v_anchor := E'          and cl.shift_code::text = sd.shift_code::text\n'
             || E'          and k.status in (''active'', ''draft''));\n';
    v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if v_n <> 1 then
      raise exception '0478: save_contract anchor found % times, expected 1', v_n;
    end if;
    v_ins := E'          and cl.shift_code::text = sd.shift_code::text\n'
          || E'          and k.status in (''active'', ''draft''))\n'
          || E'     -- 0478: nor where an addendum staffs it — a site opened by addendum\n'
          || E'     -- has no line, and its shift must survive this clean-up.\n'
          || E'     and not exists (\n'
          || E'       select 1 from public.contract_addendums a\n'
          || E'         join public.contracts k on k.id = a.contract_id\n'
          || E'        where a.site_id = sd.site_id\n'
          || E'          and a.shift_code::text = sd.shift_code::text\n'
          || E'          and k.status in (''active'', ''draft''));\n';
    v_new := replace(v_def, v_anchor, v_ins);
    execute v_new;
  end if;

  -- Each marker now present exactly once.
  if (select count(*) from unnest(array[
        pg_get_functiondef('public.enforce_contract_line_headcount'::regproc),
        pg_get_functiondef('public.enforce_deployment_slot_free'::regproc),
        pg_get_functiondef('public.save_contract'::regproc)]) d
       where (length(d) - length(replace(d, '0478:', ''))) / 5 = 1) <> 3 then
    raise exception '0478: a surgery marker is missing or doubled';
  end if;
end $mig$;

-- ── 2b. an addendum that staffs a site creates that site's shift ─────────────
create or replace function public.addendum_staffs_its_shift()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.site_id is null or new.shift_code is null then
    return new;
  end if;
  -- save_contract's default hours, so a shift reads the same whichever path made it.
  insert into public.shift_definitions (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
  select new.company_id, new.site_id, new.shift_code,
         w.start_time, w.end_time, w.duration_hours, w.crosses_midnight
    from (values ('day',     time '08:00', time '20:00', 12::numeric, false),
                 ('evening', time '16:00', time '00:00',  8::numeric, true),
                 ('night',   time '20:00', time '08:00', 12::numeric, true))
         w (code, start_time, end_time, duration_hours, crosses_midnight)
   where w.code = new.shift_code::text
  on conflict (site_id, shift_code) do nothing;
  return new;
end
$function$;

comment on function public.addendum_staffs_its_shift() is
  'A contract addendum that names a site and shift creates that (site, shift) shift_definition, '
  'with save_contract''s default hours — a site opened by addendum has no contract line to do it (0478).';

drop trigger if exists trg_contract_addendums_staff_shift on public.contract_addendums;
create trigger trg_contract_addendums_staff_shift
  after insert or update of site_id, shift_code on public.contract_addendums
  for each row execute function public.addendum_staffs_its_shift();

-- Backfill: addendums already naming a site and shift.
insert into public.shift_definitions (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
select distinct a.company_id, a.site_id, a.shift_code,
       w.start_time, w.end_time, w.duration_hours, w.crosses_midnight
  from public.contract_addendums a
  join (values ('day',     time '08:00', time '20:00', 12::numeric, false),
               ('evening', time '16:00', time '00:00',  8::numeric, true),
               ('night',   time '20:00', time '08:00', 12::numeric, true))
       w (code, start_time, end_time, duration_hours, crosses_midnight)
    on w.code = a.shift_code::text
 where a.site_id is not null
on conflict (site_id, shift_code) do nothing;

do $$
declare v_n int;
begin
  select count(*) into v_n
    from public.contract_addendums a
   where a.site_id is not null and a.shift_code is not null
     and not exists (select 1 from public.shift_definitions sd
                      where sd.site_id = a.site_id and sd.shift_code = a.shift_code);
  if v_n <> 0 then
    raise exception '0478: % addendum(s) still staff a site with no shift definition', v_n;
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
