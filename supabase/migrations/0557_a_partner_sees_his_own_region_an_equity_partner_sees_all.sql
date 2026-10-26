-- 0557 — a partner sees his own region; an equity partner sees everything
--
-- DECIDED 2026-10-26 (Shayan): "when a partner is opening the tab say nauman
-- ahmed he will only see his region and his share when an equity partner is
-- opening he will see a snapshot of everything".
--
-- Partner logins already exist (profiles.user_type = 'partner', partner_scope
-- naming the partner row): Nauman → Nauman Ahmed (regional, ISB/RWP),
-- Shafqat → Shafqat Ali Raza (regional, Lahore), Shujaat → Shujaat Mehmood
-- (equity). Until now nothing limited what they could read of a month: the
-- run (profit_allocation_runs, every region and every client) was readable by
-- anyone in the company, and Nauman's and Shafqat's receivables/payables
-- permissions open the partnership pages.
--
-- So:
--   * partnership_viewer(): who is looking — 'all' (an equity partner, or a
--     user who is not partner-scoped and holds accounting.edit or
--     reports.view), 'region' (a regional partner: his partner rows and his
--     regions), or 'none'. can_manage = accounting.edit (draft/post/reverse).
--   * partnership_month_view(company, month): the month as the viewer may see
--     it — the run's status and totals, its regions, each visible partner's
--     statement (client by client from the run's stored inputs, region by
--     region for equity, the month's drawings and closing balance from
--     partner_ledger), the clients' revenue/cost/overhead/net for the visible
--     regions, and the last twelve months. A regional partner gets only his
--     own region, his own share, his own clients and his own account; nothing
--     company-wide.
--   * profit_allocation_runs is closed to partner-scoped logins (restrictive
--     read policy): they read the month only through the function above.
--   * partner_ledger (many authors — surgery on its one guard line) lets an
--     EQUITY partner's login read every partner's account, so his snapshot of
--     everything includes each partner's balance. A regional partner still
--     reads only his own.
--
-- Asserted: a regional partner's view names only his region and himself; the
-- equity view names every region and every partner; the run table returns
-- nothing to a partner login.

create or replace function public.partnership_viewer()
returns table(mode text, partner_ids uuid[], branch_ids uuid[], can_manage boolean)
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_scope uuid[]; v_company boolean; v_branches uuid[];
begin
  if public.is_partner_scoped() then
    v_scope := public.current_partner_scope();
    select bool_or(p.scope = 'COMPANY'), array_agg(p.branch_id) filter (where p.scope = 'BRANCH' and p.branch_id is not null)
      into v_company, v_branches
      from public.partners p where p.id = any (v_scope);
    return query select case when coalesce(v_company, false) then 'all' else 'region' end,
                        v_scope, coalesce(v_branches, '{}'::uuid[]), false;
    return;
  end if;
  return query select case when public.has_perm('accounting.edit') or public.has_perm('reports.view') then 'all' else 'none' end,
                      '{}'::uuid[], '{}'::uuid[], public.has_perm('accounting.edit');
end $function$;
revoke all on function public.partnership_viewer() from public, anon;
grant execute on function public.partnership_viewer() to authenticated;

create or replace function public.partnership_month_view(p_company_id uuid, p_period date)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_m date := date_trunc('month', p_period)::date;
  v_end date := (date_trunc('month', p_period) + interval '1 month - 1 day')::date;
  v record; r public.profit_allocation_runs; v_all boolean;
  v_regions jsonb; v_partners jsonb := '[]'::jsonb; v_clients jsonb; v_months jsonb; v_run jsonb;
  pid uuid; v_lines jsonb; v_eq jsonb; v_amount numeric; v_kind text; v_name text; v_scope text; v_region text; v_pct numeric;
  v_draw numeric; v_rem numeric; v_close numeric;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  select * into v from public.partnership_viewer();
  if v.mode = 'none' then
    raise exception 'The partnership is not open to you.' using errcode = '42501';
  end if;
  v_all := v.mode = 'all';

  select * into r from public.profit_allocation_runs where company_id = p_company_id and period_month = v_m;

  -- The run, at the viewer's level.
  if r.id is not null then
    v_run := jsonb_build_object(
      'id', r.id, 'status', r.status, 'basis', r.basis, 'posted_at', r.posted_at, 'reversed_at', r.reversed_at,
      'posted_by', (select full_name from public.profiles where id = r.posted_by),
      'entry_id', case when v_all then r.entry_id end,
      'total_profit', case when v_all then r.total_profit end,
      'regional_total', case when v_all then r.regional_total end,
      'equity_total', case when v_all then r.equity_total end,
      'unallocated', case when v_all then (select coalesce(sum((e->>'amount')::numeric), 0) from jsonb_array_elements(r.outputs) e where e->>'row_kind' = 'UNALLOCATED') end);
  end if;

  -- Regions: all, or the viewer's own.
  select coalesce(jsonb_agg(jsonb_build_object(
           'branch_id', e->>'branch_id', 'region', e->>'region_name',
           'own_profit', (e->>'own_profit')::numeric, 'ho_allocated', (e->>'ho_allocated')::numeric,
           'base', (e->>'base_amount')::numeric, 'regional', (e->>'amount')::numeric, 'to_equity', (e->>'residual')::numeric,
           'regional_partners', (select coalesce(jsonb_agg(jsonb_build_object('name', x->>'partner_name', 'pct', (x->>'share_pct')::numeric)), '[]'::jsonb)
                                   from jsonb_array_elements(r.outputs) x where x->>'row_kind' = 'REGIONAL_PARTNER' and x->>'branch_id' = e->>'branch_id'),
           'outside', exists (select 1 from public.partnership_region_settings s where s.branch_id = (e->>'branch_id')::uuid
                                and s.outside_from <= v_m and (s.outside_to is null or s.outside_to >= v_m)),
           'declared', (select d.amount from public.region_declared_profit d where d.branch_id = (e->>'branch_id')::uuid and d.period_month = v_m)
         ) order by (e->>'own_profit')::numeric desc), '[]'::jsonb)
    into v_regions
    from jsonb_array_elements(coalesce(r.outputs, '[]'::jsonb)) e
   where e->>'row_kind' = 'REGION' and (v_all or (e->>'branch_id')::uuid = any (v.branch_ids));

  -- Partners: all who have a line this month, or the viewer himself.
  for pid in
    select distinct (e->>'partner_id')::uuid from jsonb_array_elements(coalesce(r.outputs, '[]'::jsonb)) e
     where e->>'row_kind' in ('REGIONAL_PARTNER', 'EQUITY_PARTNER') and (v_all or (e->>'partner_id')::uuid = any (v.partner_ids))
  loop
    select p.name, p.scope, b.name into v_name, v_scope, v_region from public.partners p left join public.branches b on b.id = p.branch_id where p.id = pid;
    select coalesce(sum((e->>'amount')::numeric), 0), max((e->>'share_pct')::numeric) into v_amount, v_pct
      from jsonb_array_elements(r.outputs) e where e->>'partner_id' = pid::text and e->>'row_kind' in ('REGIONAL_PARTNER', 'EQUITY_PARTNER');
    select coalesce(jsonb_agg(jsonb_build_object('client_id', i->>'client_id', 'client', c.name,
             'net', (i->>'client_net')::numeric, 'pct', (i->>'pct')::numeric,
             'share', round((i->>'client_net')::numeric * (i->>'pct')::numeric / 100, 2))
             order by (i->>'client_net')::numeric * (i->>'pct')::numeric desc), '[]'::jsonb)
      into v_lines
      from jsonb_array_elements(coalesce(r.inputs, '[]'::jsonb)) i left join public.clients c on c.id = (i->>'client_id')::uuid
     where i->>'partner_id' = pid::text and (i->>'client_net')::numeric <> 0;
    select coalesce(jsonb_agg(jsonb_build_object('region', e->>'region_name', 'amount', (e->>'amount')::numeric, 'pct', (e->>'share_pct')::numeric)
             order by (e->>'amount')::numeric desc), '[]'::jsonb)
      into v_eq
      from jsonb_array_elements(r.outputs) e where e->>'row_kind' = 'EQUITY_REGION' and e->>'partner_id' = pid::text;
    select coalesce(sum(l.cash_paid) filter (where l.entry_date between v_m and v_end), 0),
           coalesce(sum(l.remuneration) filter (where l.entry_date between v_m and v_end), 0)
      into v_draw, v_rem
      from public.partner_ledger(pid, null, v_end) l;
    -- The closing balance is the ledger's last line, in the ledger's own order
    -- (several lines can share a date).
    select x.balance into v_close
      from (select l.balance, row_number() over () rn from public.partner_ledger(pid, null, v_end) l) x
     order by x.rn desc limit 1;
    v_partners := v_partners || jsonb_build_array(jsonb_build_object(
      'partner_id', pid, 'name', v_name, 'kind', case when v_scope = 'COMPANY' then 'equity' else 'regional' end,
      'region', v_region, 'pct', v_pct, 'amount', v_amount, 'clients', v_lines, 'equity_regions', v_eq,
      'drawings_month', v_draw, 'profit_month', v_rem, 'closing_balance', coalesce(v_close, 0)));
  end loop;

  -- Clients of the visible regions: revenue, cost, overhead, net on the run's basis.
  select coalesce(jsonb_agg(jsonb_build_object('client_id', s.client_id, 'client', coalesce(s.client_name, 'Head office — unallocated'),
           'branch_id', s.branch_id, 'region', s.region_name, 'revenue', s.revenue,
           'cost', s.direct_payroll + s.direct_expenses, 'overhead', s.regional_overhead + s.ho_share, 'net', s.net)
           order by s.net desc), '[]'::jsonb)
    into v_clients
    from public.client_statement_loaded(v_m, v_end, coalesce(r.basis, 'cash'), p_company_id) s
   where (s.revenue <> 0 or s.net <> 0)
     and (v_all or (s.client_id is not null and s.branch_id = any (v.branch_ids)));

  -- The last twelve months: state, and the profit (all) or his share (region).
  select coalesce(jsonb_agg(jsonb_build_object('month', x.period_month, 'status', x.status,
           'amount', case when v_all then x.total_profit
                          else (select coalesce(sum((e->>'amount')::numeric), 0) from jsonb_array_elements(x.outputs) e
                                 where e->>'row_kind' in ('REGIONAL_PARTNER', 'EQUITY_PARTNER') and (e->>'partner_id')::uuid = any (v.partner_ids)) end)
           order by x.period_month), '[]'::jsonb)
    into v_months
    from public.profit_allocation_runs x
   where x.company_id = p_company_id and x.period_month > (v_m - interval '12 month')::date and x.period_month <= (v_m + interval '3 month')::date;

  return jsonb_build_object(
    'viewer', jsonb_build_object('mode', v.mode, 'can_manage', v.can_manage, 'partner_ids', to_jsonb(v.partner_ids)),
    'month', v_m, 'run', v_run, 'regions', v_regions, 'partners', v_partners, 'clients', v_clients, 'months', v_months);
end $function$;
revoke all on function public.partnership_month_view(uuid, date) from public, anon;
grant execute on function public.partnership_month_view(uuid, date) to authenticated;
comment on function public.partnership_month_view(uuid, date) is
  'DECIDED 2026-10-26 (0557). A month of the partnership as the viewer may see it: everything for an equity partner or '
  'an accounting user; only his own region, share, clients and account for a regional partner.';

-- An equity partner's login reads every partner's account (the snapshot of everything).
do $surgery$
declare
  v_def text := pg_get_functiondef('public.partner_ledger(uuid, date, date)'::regprocedure);
  v_anchor constant text := 'if public.is_partner_scoped() and not (p_partner_id = any(public.current_partner_scope())) then return; end if;';
  v_n int;
begin
  if position('0557' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0557 REFUSED: the guard appears % times in partner_ledger.', v_n; end if;
  v_def := replace(v_def, v_anchor,
    'if public.is_partner_scoped() and not (p_partner_id = any(public.current_partner_scope()))' || E'\n' ||
    '     and not exists (select 1 from public.partners ep where ep.id = any(public.current_partner_scope()) and ep.scope = ''COMPANY'')  -- 0557: an equity partner sees every account' || E'\n' ||
    '  then return; end if;');
  execute v_def;
end $surgery$;

-- The raw run is closed to partner logins: they read it only through the view above.
drop policy if exists not_partner_scoped on public.profit_allocation_runs;
create policy not_partner_scoped on public.profit_allocation_runs as restrictive for select
  using (not (select public.is_partner_scoped()));

-- ── asserts ───────────────────────────────────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_nauman_user uuid; v_shujaat_user uuid; v_view jsonb; v_nauman_view jsonb; v_n int;
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name in ('partnership_month_view', 'partnership_viewer')) then
    raise exception '0557 REFUSED: tenant_guard_gaps names a partnership view function.';
  end if;
  select id into v_nauman_user from public.profiles where user_type = 'partner' and partner_scope @> array['5b52b367-30bb-4e22-89b1-aea4885b8499'::uuid] limit 1;
  select id into v_shujaat_user from public.profiles where user_type = 'partner' and partner_scope @> array['9e53fef6-10f1-42fd-8d27-380d5e038c14'::uuid] limit 1;
  if v_nauman_user is null or v_shujaat_user is null then
    raise notice '0557: partner logins not found — proof skipped.';
    return;
  end if;
  if not exists (select 1 from public.profit_allocation_runs where company_id = v_co and period_month = '2026-09-01') then
    raise notice '0557: no September run — proof skipped.';
    return;
  end if;

  -- As Nauman: his region and himself only.
  perform set_config('request.jwt.claims', json_build_object('sub', v_nauman_user, 'role', 'authenticated')::text, true);
  v_view := public.partnership_month_view(v_co, '2026-09-01');
  if jsonb_array_length(v_view->'regions') <> 1 or v_view->'regions'->0->>'region' <> 'ISB/RWP' then
    raise exception '0557 REFUSED: Nauman sees regions %.', v_view->'regions';
  end if;
  if jsonb_array_length(v_view->'partners') <> 1 or v_view->'partners'->0->>'name' <> 'Nauman Ahmed' then
    raise exception '0557 REFUSED: Nauman sees partners %.', (select jsonb_agg(p->>'name') from jsonb_array_elements(v_view->'partners') p);
  end if;
  if v_view->'run'->>'total_profit' is not null then raise exception '0557 REFUSED: Nauman sees the company total.'; end if;
  if exists (select 1 from jsonb_array_elements(v_view->'clients') c where c->>'region' <> 'ISB/RWP') then
    raise exception '0557 REFUSED: Nauman sees a client outside ISB/RWP.';
  end if;
  v_nauman_view := v_view;
  -- Read the table as a signed-in user would (the migration role bypasses RLS).
  execute 'set local role authenticated';
  select count(*) into v_n from public.profit_allocation_runs;
  execute 'reset role';
  if v_n <> 0 then raise exception '0557 REFUSED: a partner login reads % runs directly.', v_n; end if;

  -- As Shujaat: everything.
  perform set_config('request.jwt.claims', json_build_object('sub', v_shujaat_user, 'role', 'authenticated')::text, true);
  v_view := public.partnership_month_view(v_co, '2026-09-01');
  if jsonb_array_length(v_view->'partners') < 2 or jsonb_array_length(v_view->'regions') < 2 or v_view->'run'->>'total_profit' is null then
    raise exception '0557 REFUSED: the equity view is not the whole month (% partners, % regions).',
      jsonb_array_length(v_view->'partners'), jsonb_array_length(v_view->'regions');
  end if;
  if (select (p->>'closing_balance')::numeric from jsonb_array_elements(v_view->'partners') p where p->>'name' = 'Nauman Ahmed')
     is distinct from (select (p->>'closing_balance')::numeric from jsonb_array_elements(v_nauman_view->'partners') p) then
    raise exception '0557 REFUSED: the equity view and Nauman''s own disagree on his closing balance.';
  end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice '0557: Nauman sees ISB/RWP and himself; Shujaat sees the whole month.';
end $mig$;
