-- 0477 — An addendum is its own record. It never writes a contract line.
--
-- The addendum form briefly created a real contract_lines row for "Add
-- headcount" (0-count base, the addendum carrying the heads). That put
-- addendum posts inside the site's contract lines table, which is exactly what
-- the Addendums section promises not to do: "the contract's base lines are
-- never altered". Wanted instead: an ADD_HEADCOUNT addendum carries the same
-- fields a contract line does — site, category, shift, rate / month, taxable,
-- notes — on the addendum row itself, with contract_line_id null.
--
-- REDUCE_HEADCOUNT and RATE_CHANGE still point at an existing line
-- (contract_line_id): they change a line; they are not one.
--
-- MEASURED BEFORE (prod): exactly one addendum-created line exists —
-- CON-0005 (Nova Group), Guard / day / Nova Islamabad, committed 0,
-- PKR 42,000, no employees and no deployments on it, one ADD_HEADCOUNT +1
-- effective 2026-09-20 pointing at it. It is converted: the addendum takes the
-- line's site / category / shift / rate / taxable / notes, and the empty line
-- is deleted. Identified by shape (0 committed, only ADD_HEADCOUNT addendums,
-- nobody on it), not by id, and the count is asserted.

alter table public.contract_addendums
  add column if not exists site_id   uuid references public.sites(id) on delete set null,
  add column if not exists unit_rate numeric(12,2),
  add column if not exists taxable   boolean,
  add column if not exists notes     text;

comment on column public.contract_addendums.site_id is
  'ADD_HEADCOUNT with no contract_line_id: the site the added heads staff. '
  'Null on contract-wide contracts, on line-targeted addendums and on renewals (0477).';
comment on column public.contract_addendums.unit_rate is
  'ADD_HEADCOUNT with no contract_line_id: rate / month per added head, as on a contract line (0477).';
comment on column public.contract_addendums.taxable is
  'ADD_HEADCOUNT with no contract_line_id: whether the added heads are taxable, as on a contract line (0477).';
comment on column public.contract_addendums.notes is
  'ADD_HEADCOUNT with no contract_line_id: line notes, as on a contract line (0477).';

do $mig$
declare
  v_lines int;
  v_moved int;
  v_left  int;
begin
  create temp table _addendum_made_lines on commit drop as
  select l.*
    from public.contract_lines l
   where l.committed_count = 0
     and exists (select 1 from public.contract_addendums a where a.contract_line_id = l.id)
     and not exists (select 1 from public.contract_addendums a
                      where a.contract_line_id = l.id and a.change_type::text <> 'ADD_HEADCOUNT')
     and not exists (select 1 from public.employees e where e.contract_line_id = l.id)
     and not exists (select 1 from public.deployments d where d.contract_line_id = l.id);

  select count(*) into v_lines from _addendum_made_lines;
  -- 1 on prod before; 0 on a replay (already converted) or on dev.
  if v_lines > 1 then
    raise exception '0477: expected at most 1 addendum-created line, found %', v_lines;
  end if;

  update public.contract_addendums a
     set contract_line_id = null,
         category  = l.category,
         site_id   = l.site_id,
         shift_code = coalesce(a.shift_code, l.shift_code),
         unit_rate = l.unit_rate,
         taxable   = l.taxable,
         notes     = l.location
    from _addendum_made_lines l
   where a.contract_line_id = l.id;
  get diagnostics v_moved = row_count;

  delete from public.contract_lines l using _addendum_made_lines m where l.id = m.id;

  select count(*) into v_left
    from public.contract_lines l join _addendum_made_lines m on m.id = l.id;
  if v_left <> 0 then
    raise exception '0477: % addendum-created line(s) survived the delete', v_left;
  end if;
  raise notice '0477: converted % line(s), % addendum(s)', v_lines, v_moved;
end $mig$;

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
