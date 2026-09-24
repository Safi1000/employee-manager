-- 0479 — A post opened by addendum is capped at the headcount the addendum adds.
--
-- 0477/0478 let an addendum add headcount at a site/category with no contract
-- line of its own (a site opened by addendum, or a department a site never had).
-- A guard posted there had nothing to stand on: deployments carry the site but
-- no category, and the category lives only on a contract line. So the posting
-- went in with contract_line_id null, enforce_deployment_slot_free returned at
-- its first line, and an addendum raising headcount by 3 could be filled by 5.
--
-- Now a posting may name the addendum post it fills: deployments.contract_addendum_id,
-- an ADD_HEADCOUNT addendum with no line (never both a line and an addendum).
-- The cap is the SAME group 0457 defined — (contract, category, site), across
-- shifts — and both sides of it now see both kinds of post:
--
--   committed = the group's lines (+ their own addendums) + line-less addendums
--               in force by the joining date                         (0478)
--   covering  = distinct other guards whose posting covers the joining date,
--               whether it stands on one of the group's LINES or on one of its
--               ADDENDUMS                                            (this file)
--
-- Counting both on both paths matters later: a site opened by addendum is
-- offered to the contract lines (0477 screen), and a line added there must
-- not double the cap for the guards already filling the addendum.
--
-- enforce_deployment_slot_free has many authors (0408, 0415, 0457, 0463, 0464,
-- 0467, 0478), so it is amended by SURGERY with each anchor asserted once, and
-- skipped on replay when the 0479 marker is present.

alter table public.deployments
  add column if not exists contract_addendum_id uuid
    references public.contract_addendums(id) on delete set null;

comment on column public.deployments.contract_addendum_id is
  'The addendum post this posting fills: an ADD_HEADCOUNT contract_addendums row with no '
  'contract line (a site/category staffed only by addendum). Null for a posting on a line. '
  'Capped with its (contract, category, site) group by enforce_deployment_slot_free (0479).';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.deployments'::regclass
                    and conname = 'deployments_line_or_addendum_not_both') then
    alter table public.deployments
      add constraint deployments_line_or_addendum_not_both
      check (contract_line_id is null or contract_addendum_id is null);
  end if;
end $$;

create index if not exists deployments_contract_addendum_id_idx
  on public.deployments (contract_addendum_id) where contract_addendum_id is not null;

do $mig$
declare
  v_def    text;
  v_new    text;
  v_anchor text;
  v_ins    text;
  v_n      int;
  -- Distinct other guards covering v_start on the group, by line OR by addendum.
  v_covering_sql constant text :=
       E'    from public.deployments d\n'
    || E'    left join public.contract_lines l on l.id = d.contract_line_id\n'
    || E'    left join public.contract_addendums ad on ad.id = d.contract_addendum_id\n'
    || E'   where (l.id is not null or ad.id is not null)\n'
    || E'     and coalesce(l.contract_id, ad.contract_id) = v_contract\n'
    || E'     and coalesce(l.category::text, ad.category::text) = v_category\n'
    || E'     and (case when l.id is not null then l.site_id else ad.site_id end) is not distinct from v_site\n'
    || E'     and d.guard_id <> new.guard_id\n';
begin
  v_def := pg_get_functiondef('public.enforce_deployment_slot_free'::regproc);
  if position('0479:' in v_def) > 0 then
    return;
  end if;

  -- ── A. the addendum-post path, ahead of the line path ──────────────────────
  v_anchor := E'  if new.contract_line_id is null then return new; end if;\n';
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0479: entry anchor found % times, expected 1', v_n;
  end if;
  v_ins :=
       E'  -- 0479: a posting that fills an ADDENDUM post (no line of its own) is\n'
    || E'  -- capped by the same (contract, category, site) group as a line posting.\n'
    || E'  if new.contract_line_id is null then\n'
    || E'    if new.contract_addendum_id is null then return new; end if;\n'
    || E'    if tg_op = ''UPDATE''\n'
    || E'       and new.contract_addendum_id is not distinct from old.contract_addendum_id\n'
    || E'       and new.site_id is not distinct from old.site_id\n'
    || E'       and new.start_date >= old.start_date then\n'
    || E'      return new;\n'
    || E'    end if;\n'
    || E'    select a.contract_id, a.category::text, a.site_id,\n'
    || E'           initcap(replace(a.category::text, ''_'', '' ''))\n'
    || E'      into v_contract, v_category, v_site, v_label\n'
    || E'      from public.contract_addendums a\n'
    || E'     where a.id = new.contract_addendum_id\n'
    || E'       and a.contract_line_id is null\n'
    || E'       and a.change_type::text = ''ADD_HEADCOUNT''\n'
    || E'       and a.category is not null;\n'
    || E'    if v_contract is null then\n'
    || E'      raise exception ''A posting can only fill an addendum that adds headcount of its own (no contract line).''\n'
    || E'        using errcode = ''check_violation'';\n'
    || E'    end if;\n'
    || E'    if v_site is distinct from new.site_id then\n'
    || E'      raise exception ''This posting is not at the site the addendum staffs.''\n'
    || E'        using errcode = ''check_violation'';\n'
    || E'    end if;\n'
    || E'    -- The group''s lines (if a line was added there later) plus its line-less\n'
    || E'    -- addendums, as of the joining date.\n'
    || E'    select coalesce(sum(greatest(0, l.committed_count + coalesce((\n'
    || E'        select sum(case a.change_type::text\n'
    || E'                     when ''ADD_HEADCOUNT''    then  abs(coalesce(a.count_delta, 0))\n'
    || E'                     when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0))\n'
    || E'                     else 0\n'
    || E'                   end)\n'
    || E'          from public.contract_addendums a\n'
    || E'         where a.contract_line_id = l.id\n'
    || E'           and a.effective_from <= v_start), 0))), 0)\n'
    || E'      into v_committed\n'
    || E'      from public.contract_lines l\n'
    || E'     where l.contract_id = v_contract\n'
    || E'       and l.category::text = v_category\n'
    || E'       and l.site_id is not distinct from v_site;\n'
    || E'    v_committed := greatest(0, v_committed + coalesce((\n'
    || E'        select sum(case a.change_type::text\n'
    || E'                     when ''ADD_HEADCOUNT''    then  abs(coalesce(a.count_delta, 0))\n'
    || E'                     when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0))\n'
    || E'                     else 0\n'
    || E'                   end)\n'
    || E'          from public.contract_addendums a\n'
    || E'         where a.contract_id = v_contract\n'
    || E'           and a.contract_line_id is null\n'
    || E'           and a.category::text = v_category\n'
    || E'           and a.site_id is not distinct from v_site\n'
    || E'           and a.effective_from <= v_start), 0));\n'
    || E'    select count(distinct d.guard_id)\n'
    || E'      into v_covering\n'
    || v_covering_sql
    || E'     and d.start_date <= v_start\n'
    || E'     and (d.end_date is null or d.end_date >= v_start);\n'
    || E'    if v_covering >= v_committed then\n'
    || E'      raise exception\n'
    || E'        ''% at this site is full on %: the addendum commits % and % already fill it. Add headcount by addendum, or pick a date after the previous holder''''s last working day.'',\n'
    || E'        v_label, to_char(v_start, ''DD Mon YYYY''), v_committed, v_covering\n'
    || E'        using errcode = ''check_violation'';\n'
    || E'    end if;\n'
    || E'    return new;\n'
    || E'  end if;\n';
  v_new := replace(v_def, v_anchor, v_ins);

  -- ── B. the line path's covering count also sees addendum posts ─────────────
  v_anchor :=
       E'    from public.deployments d\n'
    || E'    join public.contract_lines l on l.id = d.contract_line_id\n'
    || E'   where l.contract_id = v_contract\n'
    || E'     and l.category::text = v_category\n'
    || E'     and l.site_id is not distinct from v_site\n'
    || E'     and d.guard_id <> new.guard_id\n';
  v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0479: covering anchor found % times, expected 1', v_n;
  end if;
  v_new := replace(v_new, v_anchor,
       E'    -- 0479: guards filling the group''s addendum posts count too.\n'
    || v_covering_sql);

  -- the line path's UPDATE skip must also notice a posting moved off an addendum
  v_anchor := E'     and new.contract_line_id is not distinct from old.contract_line_id\n'
           || E'     and new.start_date >= old.start_date then\n';
  v_n := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0479: update-skip anchor found % times, expected 1', v_n;
  end if;
  v_new := replace(v_new, v_anchor,
       E'     and new.contract_line_id is not distinct from old.contract_line_id\n'
    || E'     and new.contract_addendum_id is not distinct from old.contract_addendum_id\n'
    || E'     and new.start_date >= old.start_date then\n');

  execute v_new;

  v_def := pg_get_functiondef('public.enforce_deployment_slot_free'::regproc);
  if (length(v_def) - length(replace(v_def, '0479:', ''))) / 5 <> 2 then
    raise exception '0479: expected exactly 2 markers after surgery';
  end if;
end $mig$;

-- Nothing on prod fills an addendum post yet (the column is new), so no existing
-- posting is judged; the cap applies from the next posting on.

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
