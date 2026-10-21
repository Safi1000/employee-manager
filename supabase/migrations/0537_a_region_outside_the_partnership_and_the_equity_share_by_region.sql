-- 0537 — a region outside the partnership, and the equity share by region
--
-- DECIDED 2026-10-21 (Shayan), for the Lahore region and Maj Shafqat Ali Raza:
--
--   * Lahore is OUTSIDE the partnership calculation from the start (2026-09).
--     Its clients pay into the company's banks and the company sends Shafqat
--     the money back less the company's profit, so its entries are still
--     recorded in Bastion — but its profit is not computed from them. Shafqat
--     bears every Lahore operating loss himself; netting Lahore's clients and
--     splitting the region 45/55 (what Bastion did) made the company absorb
--     his losses.
--   * The company's Lahore profit for a month is DECLARED: a figure entered
--     for the month, with no money movement and no ledger entry (the money is
--     already in the company's banks). In the partnership it is Lahore's whole
--     contribution and goes 100% to the equity partner. Shafqat gets no
--     regional-partner line while Lahore is outside.
--   * Shujaat Mehmood's equity share is produced PER REGION and posted as one
--     capital line per region, so his ledger shows where each part came from.
--     All operating capital is his, so a region that spends more than it
--     earns shows there as a negative line: it used his money.
--
-- DEFERRED (asked 2026-10-21, answered, to build once Lahore is fully
-- migrated): Lahore client-by-client. On a profitable client Shafqat 45% /
-- company 55%. A client's loss is Shafqat's alone, carried forward against
-- THAT client and recovered from that client's later profit before any split.
-- Lahore's general costs are charged by him to specific clients; Lahore takes
-- no head-office share. The change, when made: replace the declared figure
-- for Lahore with a per-client waterfall inside partnership_allocation
-- (client net, minus that client's carried-forward loss, 45/55 on what is
-- left; a negative client adds to its carry-forward and costs the company
-- nothing), and end Lahore's row in partnership_region_settings.
--
--   partnership_region_settings     region + outside_from (+ outside_to)
--   region_declared_profit          region, month, amount, note
--   region_outside_partnership()    is this region outside in this month?
--   declare_region_profit(...)      upsert a month's figure (accounting.edit)
--   partnership_allocation          surgery: an outside region's profit is its
--                                   declared figure; no regional partner for it;
--                                   new EQUITY_REGION rows (equity share per region)
--   run_profit_allocation           surgery: equity credit posted per region
--   partnership_uninvoiced_clients  surgery: an outside region's clients are not
--                                   "missing invoices" for the run
--
-- All three surgeries against the LIVE definitions (each function has been
-- edited by many migrations), every anchor asserted exactly once.

-- ── the setting ──────────────────────────────────────────────────────────────
create table if not exists public.partnership_region_settings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  branch_id    uuid not null references public.branches(id),
  outside_from date not null check (outside_from = date_trunc('month', outside_from)::date),
  outside_to   date check (outside_to is null or outside_to >= outside_from),
  note         text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (branch_id, outside_from)
);
comment on table public.partnership_region_settings is
  '0537. A region outside the partnership calculation for [outside_from, outside_to]: its profit is the '
  'declared figure in region_declared_profit, all of it to the equity partner, and it has no regional partner line.';

create table if not exists public.region_declared_profit (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  branch_id    uuid not null references public.branches(id),
  period_month date not null check (period_month = date_trunc('month', period_month)::date),
  amount       numeric(14,2) not null,
  note         text,
  updated_by   uuid default auth.uid(),
  updated_at   timestamptz not null default now(),
  unique (branch_id, period_month)
);
comment on table public.region_declared_profit is
  '0537. The company''s profit from a region outside the partnership, for one month, as declared. No money '
  'and no ledger entry: the money is already in the company''s banks. Written only by declare_region_profit.';

do $$
declare t text;
begin
  foreach t in array array['partnership_region_settings', 'region_declared_profit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists company_members on public.%I', t);
    execute format('create policy company_members on public.%I as permissive for all using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()))', t);
    execute format('drop policy if exists ssa_all on public.%I', t);
    execute format('create policy ssa_all on public.%I as permissive for all using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()))', t);
    execute format('drop policy if exists perm_read on public.%I', t);
    execute format('create policy perm_read on public.%I as restrictive for select using ((select public.has_perm(''accounting.edit'')) or (select public.has_perm(''reports.view'')) or (select public.has_perm(''accountant.view'')) or (select public.has_perm(''partnership.post'')))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop trigger if exists trg_zzz_%s_audit on public.%I', t, t);
    execute format('create trigger trg_zzz_%s_audit after insert or update or delete on public.%I for each row execute function public.log_audit_change()', t, t);
  end loop;
end $$;

-- Lahore, from the start.
insert into public.partnership_region_settings (company_id, branch_id, outside_from, note)
select b.company_id, b.id, date '2026-09-01',
       'DECIDED 2026-10-21 (Shayan): Lahore is outside the partnership from the start; its company profit is declared monthly. See 0537.'
  from public.branches b
 where b.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and b.name = 'Lahore'
on conflict (branch_id, outside_from) do nothing;

create or replace function public.region_outside_partnership(p_branch_id uuid, p_month date)
returns boolean
language sql stable security definer set search_path to 'public'
as $function$
  select exists (select 1 from public.partnership_region_settings s
                  where s.branch_id = p_branch_id
                    and s.outside_from <= date_trunc('month', p_month)::date
                    and (s.outside_to is null or s.outside_to >= date_trunc('month', p_month)::date));
$function$;
-- Called only from inside the definer partnership functions; no caller of its
-- own, so no tenant guard and no grant.
revoke all on function public.region_outside_partnership(uuid, date) from public, anon, authenticated;

create or replace function public.declare_region_profit(p_branch_id uuid, p_month date, p_amount numeric, p_note text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare v_company uuid; v_m date := date_trunc('month', p_month)::date;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_branch_id via public.branches
  if p_branch_id is not null then perform public.assert_same_company((select company_id from public.branches where id = p_branch_id)); end if;
  select company_id into v_company from public.branches where id = p_branch_id;
  if v_company is null then raise exception 'Choose the region. Nothing has been recorded.'; end if;
  if p_amount is null then raise exception 'Enter the profit for the month. Nothing has been recorded.'; end if;
  if not public.region_outside_partnership(p_branch_id, v_m) then
    raise exception 'This region is inside the partnership for %, so its profit is computed, not declared. Nothing has been recorded.', to_char(v_m, 'Mon YYYY');
  end if;
  if exists (select 1 from public.profit_allocation_runs r where r.company_id = v_company and r.period_month = v_m and r.status = 'POSTED') then
    raise exception 'The partnership run for % is posted. Reverse it first. Nothing has been recorded.', to_char(v_m, 'Mon YYYY');
  end if;
  insert into public.region_declared_profit (company_id, branch_id, period_month, amount, note)
  values (v_company, p_branch_id, v_m, p_amount, nullif(btrim(p_note), ''))
  on conflict (branch_id, period_month) do update
    set amount = excluded.amount, note = excluded.note, updated_by = auth.uid(), updated_at = now();
end $function$;
revoke all on function public.declare_region_profit(uuid, date, numeric, text) from public, anon;
grant execute on function public.declare_region_profit(uuid, date, numeric, text) to authenticated;

-- ── surgery ──────────────────────────────────────────────────────────────────
do $mig$
declare v_src text; v_cnt int; v_a text; v_b text;
begin
  -- partnership_allocation ----------------------------------------------------
  v_src := pg_get_functiondef('public.partnership_allocation(date,date,text,uuid)'::regprocedure);
  if position('0537' in v_src) = 0 then
    -- 1. an outside region's profit is its declared figure
    v_a := E'           case when cfg.basis = ''cash'' then r.profit_cash  else r.profit_accrual  end as profit,';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0537 REFUSED: partnership_allocation profit anchor found % times.', v_cnt; end if;
    v_b := E'           case when public.region_outside_partnership(r.branch_id, p_start)  -- 0537: declared, not computed\n'
        || E'                then coalesce((select sum(d.amount) from public.region_declared_profit d\n'
        || E'                                where d.branch_id = r.branch_id and d.period_month between p_start and p_end), 0)\n'
        || E'                when cfg.basis = ''cash'' then r.profit_cash  else r.profit_accrual  end as profit,';
    v_src := replace(v_src, v_a, v_b);

    -- 2. no regional partner for an outside region
    v_a := E'       and (p.start_month is null or p.start_month <= p_end)\n  ),\n  eq_p as';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0537 REFUSED: partnership_allocation reg_p anchor found % times.', v_cnt; end if;
    v_b := E'       and (p.start_month is null or p.start_month <= p_end)\n'
        || E'       and not public.region_outside_partnership(p.branch_id, p_start)  -- 0537\n  ),\n  eq_p as';
    v_src := replace(v_src, v_a, v_b);

    -- 3. the equity share per region
    v_a := E'  union all\n  select ''UNALLOCATED_HO''::text';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0537 REFUSED: partnership_allocation union anchor found % times.', v_cnt; end if;
    v_b := E'  union all\n'
        || E'  -- 0537. Each equity partner''s share, region by region: what each region\n'
        || E'  -- left after its regional partner. Sums to EQUITY_PARTNER (rounding aside;\n'
        || E'  -- run_profit_allocation puts the rounding on the largest region).\n'
        || E'  select ''EQUITY_REGION''::text, ra.branch_id, ra.region_name,\n'
        || E'         eq_p.id, eq_p.name, eq_p.profit_share_percent,\n'
        || E'         null::numeric, null::numeric, ra.profit - ra.taken,\n'
        || E'         round((ra.profit - ra.taken) * eq_p.profit_share_percent / 100, 2), null::numeric\n'
        || E'    from eq_p cross join reg_alloc ra\n'
        || E'  union all\n  select ''UNALLOCATED_HO''::text';
    v_src := replace(v_src, v_a, v_b);
    execute v_src;
  end if;

  -- run_profit_allocation -----------------------------------------------------
  v_src := pg_get_functiondef('public.run_profit_allocation(uuid,date,text,boolean)'::regprocedure);
  if position('0537' in v_src) = 0 then
    v_a := E'    select a.partner_id, a.partner_name, round(a.amount, 2) as amt\n'
        || E'      from public.partnership_allocation(v_month, v_end, v_basis, p_company_id) a\n'
        || E'     where a.row_kind = ''EQUITY_PARTNER'' and abs(coalesce(a.amount, 0)) > 0.005\n  loop';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0537 REFUSED: run_profit_allocation equity anchor found % times.', v_cnt; end if;
    v_b := E'    -- 0537. One line per region; the rounding goes on the largest region so\n'
        || E'    -- the lines still sum to the partner''s EQUITY_PARTNER amount exactly.\n'
        || E'    select x.partner_id, x.partner_name, x.branch_id,\n'
        || E'           case when x.rn = 1 then x.total - (x.sum_rounded - x.rr) else x.rr end as amt\n'
        || E'      from (\n'
        || E'        select a.partner_id, a.partner_name, a.branch_id, round(a.amount, 2) as rr,\n'
        || E'               row_number() over (partition by a.partner_id order by abs(a.amount) desc, a.branch_id) as rn,\n'
        || E'               sum(round(a.amount, 2)) over (partition by a.partner_id) as sum_rounded,\n'
        || E'               (select round(e.amount, 2) from public.partnership_allocation(v_month, v_end, v_basis, p_company_id) e\n'
        || E'                 where e.row_kind = ''EQUITY_PARTNER'' and e.partner_id = a.partner_id) as total\n'
        || E'          from public.partnership_allocation(v_month, v_end, v_basis, p_company_id) a\n'
        || E'         where a.row_kind = ''EQUITY_REGION''\n'
        || E'      ) x\n'
        || E'     where abs(case when x.rn = 1 then x.total - (x.sum_rounded - x.rr) else x.rr end) > 0.005\n  loop';
    v_src := replace(v_src, v_a, v_b);

    -- the equity lines carry the region (the regional-partner lines already do)
    v_a := E'''partner_id'', r.partner_id)';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 4 then raise exception '0537 REFUSED: run_profit_allocation equity line anchor found % times, expected 4.', v_cnt; end if;
    v_src := replace(v_src, v_a, E'''partner_id'', r.partner_id, ''region'', r.branch_id)');
    execute v_src;
  end if;

  -- partnership_uninvoiced_clients ---------------------------------------------
  v_src := pg_get_functiondef('public.partnership_uninvoiced_clients(uuid,date)'::regprocedure);
  if position('0537' in v_src) = 0 then
    v_a := E'     and c.status <> ''draft''\n     and p.service_month = v_start';
    v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
    if v_cnt <> 1 then raise exception '0537 REFUSED: partnership_uninvoiced_clients anchor found % times.', v_cnt; end if;
    v_src := replace(v_src, v_a, v_a || E'\n     and not public.region_outside_partnership(cl.branch_id, v_start)  -- 0537');
    execute v_src;
  end if;
end $mig$;

-- ── asserts — on the things that can break ───────────────────────────────────
do $$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_lahore uuid; v_n int; v_eq numeric; v_eqr numeric; v_pool numeric; v_reg numeric;
begin
  select id into v_lahore from public.branches where company_id = v_co and name = 'Lahore';
  if not public.region_outside_partnership(v_lahore, date '2026-09-01') then
    raise exception '0537 REFUSED: Lahore is not outside the partnership for September 2026.';
  end if;

  -- Lahore contributes its declared figure (none yet: 0) and has no regional partner.
  select count(*) into v_n from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co)
   where row_kind = 'REGIONAL_PARTNER' and branch_id = v_lahore;
  if v_n <> 0 then raise exception '0537 REFUSED: Lahore still has a regional partner line.'; end if;
  select coalesce(sum(base_amount), 0) into v_pool from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co)
   where row_kind = 'REGION' and branch_id = v_lahore;
  if v_pool <> 0 then raise exception '0537 REFUSED: Lahore contributes % with nothing declared.', v_pool; end if;

  -- The equity share by region sums to the equity share, within rounding.
  select sum(amount) filter (where row_kind = 'EQUITY_PARTNER'), sum(amount) filter (where row_kind = 'EQUITY_REGION')
    into v_eq, v_eqr from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co);
  if abs(coalesce(v_eq, 0) - coalesce(v_eqr, 0)) > 0.05 then
    raise exception '0537 REFUSED: equity by region % does not sum to equity %.', v_eqr, v_eq;
  end if;

  -- The waterfall still exhausts the pool (the run's own central assertion).
  select sum(base_amount) filter (where row_kind = 'REGION'),
         sum(amount) filter (where row_kind in ('REGIONAL_PARTNER', 'EQUITY_PARTNER'))
    into v_pool, v_reg from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co);
  if round(v_pool, 2) <> round(v_reg, 2) then
    raise exception '0537 REFUSED: September no longer exhausts its pool (% vs %).', v_reg, v_pool;
  end if;

  select count(*) into v_n from public.tenant_guard_gaps();
  if v_n <> 0 then raise exception '0537 REFUSED: tenant_guard_gaps() reports % gap(s).', v_n; end if;
end $$;
