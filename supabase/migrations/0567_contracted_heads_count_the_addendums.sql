-- 0567 — contracted heads count the addendums
--
-- Found 2026-10-28 (Shayan): "in dashboard for bank of ajk it shows contracted
-- 52 even tho it is 53 added through addendums".
--
-- client_cover() (0516, 0527) summed contract_lines.committed_count only.
-- Headcount addendums (contract_addendums) never reached it: Bank of AJK's
-- lines hold 52 and its 21 Aug addendum adds a 53rd post with no line of its
-- own. The dashboard's site tiles, Contracted vs Deployed, Client Profit and
-- the Reports overview all read this function, so all of them under-counted.
--
-- The rule is the one the deployment cap already applies
-- (enforce_deployment_slot_free, 0479): ADD_HEADCOUNT adds, REDUCE_HEADCOUNT
-- removes, from its effective date — for an addendum on a line, to that line
-- (never below zero); for a line-less addendum, to the contract under its own
-- category. As at the month's last day.
--
-- client_cover has two authors: surgery on its `con` block, anchor asserted
-- once. Asserted: Bank of AJK reads 53 for October 2026.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.client_cover(uuid, date)'::regprocedure);
  v_anchor constant text :=
E'  with con as (\n' ||
E'    select k.client_id, sum(cl.committed_count)::numeric n\n' ||
E'      from public.contracts k\n' ||
E'      join public.clients c on c.id = k.client_id and c.company_id = p_company_id\n' ||
E'      join public.contract_lines cl on cl.contract_id = k.id\n' ||
E'     where k.status = ''active'' and k.contract_type = ''guard_deployment''\n' ||
E'       and (k.start_date is null or k.start_date <= v_e)\n' ||
E'       and cl.category in (''SR_SUPERVISOR'', ''ASST_SUPERVISOR'', ''SUPERVISOR'', ''GUARD'', ''RELIEVER'')\n' ||
E'     group by 1\n' ||
E'  ),';
  v_n int;
begin
  if position('0567' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0567 REFUSED: the con block appears % times in client_cover.', v_n; end if;
  execute replace(v_def, v_anchor,
E'  -- 0567: lines with their own addendums, plus line-less headcount addendums,\n' ||
E'  -- as at the month''s last day — the rule enforce_deployment_slot_free uses.\n' ||
E'  with kk as (\n' ||
E'    select k.id, k.client_id\n' ||
E'      from public.contracts k\n' ||
E'      join public.clients c on c.id = k.client_id and c.company_id = p_company_id\n' ||
E'     where k.status = ''active'' and k.contract_type = ''guard_deployment''\n' ||
E'       and (k.start_date is null or k.start_date <= v_e)\n' ||
E'  ),\n' ||
E'  con as (\n' ||
E'    select x.client_id, sum(x.n)::numeric n from (\n' ||
E'      select kk.client_id, greatest(0, cl.committed_count + coalesce((\n' ||
E'               select sum(case a.change_type::text when ''ADD_HEADCOUNT'' then abs(coalesce(a.count_delta, 0))\n' ||
E'                                                   when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0)) else 0 end)\n' ||
E'                 from public.contract_addendums a\n' ||
E'                where a.contract_line_id = cl.id and a.effective_from <= v_e), 0)) as n\n' ||
E'        from kk join public.contract_lines cl on cl.contract_id = kk.id\n' ||
E'       where cl.category in (''SR_SUPERVISOR'', ''ASST_SUPERVISOR'', ''SUPERVISOR'', ''GUARD'', ''RELIEVER'')\n' ||
E'      union all\n' ||
E'      select kk.client_id, case a.change_type::text when ''ADD_HEADCOUNT'' then abs(coalesce(a.count_delta, 0))\n' ||
E'                                                    when ''REDUCE_HEADCOUNT'' then -abs(coalesce(a.count_delta, 0)) else 0 end\n' ||
E'        from kk join public.contract_addendums a on a.contract_id = kk.id\n' ||
E'       where a.contract_line_id is null and a.effective_from <= v_e\n' ||
E'         and a.category::text in (''SR_SUPERVISOR'', ''ASST_SUPERVISOR'', ''SUPERVISOR'', ''GUARD'', ''RELIEVER'')\n' ||
E'    ) x\n' ||
E'     group by 1\n' ||
E'  ),');
end $surgery$;

do $$
declare v numeric;
begin
  select contracted into v from public.client_cover('7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-01')
   where client_name = 'Bank of AJK';
  if v is distinct from 53 then
    raise exception '0567 REFUSED: Bank of AJK reads % contracted heads for October 2026, not 53.', v;
  end if;
end $$;
