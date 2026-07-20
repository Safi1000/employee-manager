-- Dashboards & Reporting (spec section 22).
--
-- The read layer that sits on everything built so far: a cash cockpit, a
-- per-department KPI dashboard, a regional scorecard (the RMD review page), a
-- client service report source, and the client-relationship tables (service
-- reviews, complaints, renewal pipeline) for the head-office client team.
--
-- Honest dependency notes:
--   * The full cash cockpit wants §9.1 forecast, §9.2 reserves and §9.5 danger
--     bands, which aren't built. This computes what the ledger already
--     supports (available cash after the ONE reserve that exists — the bonus
--     reserve — and a simple runway), and leaves the forecast/danger pieces to
--     §9.
--   * The regional scorecard's "inter-region balance" needs §7 (not built); it
--     is surfaced as null with a note rather than faked.

-- ===========================================================================
-- 1. Client relationship layer (tables)
-- ===========================================================================

create table if not exists public.client_service_reviews (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  review_date   date not null default current_date,
  reviewer_id   uuid,
  rating        integer check (rating between 1 and 5),
  summary       text,
  action_items  text,
  created_at    timestamptz not null default now()
);

do $$ begin
  create type public.complaint_status as enum ('open', 'in_progress', 'resolved', 'closed');
exception when duplicate_object then null; end $$;

create table if not exists public.client_complaints (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  branch_id     uuid references public.branches(id),
  raised_on     date not null default current_date,
  channel       text,
  description   text not null,
  status        public.complaint_status not null default 'open',
  resolution    text,
  resolved_on   date,
  owner_id      uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Renewal pipeline: contracts approaching their end, with a pipeline stage.
do $$ begin
  create type public.renewal_stage as enum
    ('not_started', 'contacted', 'negotiating', 'renewed', 'lost');
exception when duplicate_object then null; end $$;

create table if not exists public.renewal_pipeline (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  contract_id   uuid references public.contracts(id),
  branch_id     uuid references public.branches(id),
  stage         public.renewal_stage not null default 'not_started',
  expected_close_date date,
  owner_id      uuid,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (contract_id)
);

do $$
declare t text;
begin
  foreach t in array array['client_service_reviews', 'client_complaints', 'renewal_pipeline'] loop
    execute format('drop trigger if exists trg_aaa_%1$s_fill_company on public.%1$s', t);
    execute format('create trigger trg_aaa_%1$s_fill_company before insert on public.%1$s
                      for each row execute function public.fill_company_id()', t);
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists "ssa_all" on public.%1$s', t);
    execute format('create policy "ssa_all" on public.%1$s for all
                      using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped())', t);
    execute format('drop policy if exists "company_members" on public.%1$s', t);
    execute format('create policy "company_members" on public.%1$s for all
                      using (company_id = public.current_company_id())
                      with check (company_id = public.current_company_id())', t);
  end loop;
end$$;

-- Client relationship objects inherit their client's region.
create or replace function public.inherit_region_from_client_col()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(new.branch_id, public.region_for_client(new.client_id),
                            public.head_office_region(new.company_id));
  return new;
end;
$$;

drop trigger if exists trg_bbb_csr_region on public.client_service_reviews;
create trigger trg_bbb_csr_region before insert or update of client_id, company_id
  on public.client_service_reviews for each row execute function public.inherit_region_from_client_col();
drop trigger if exists trg_bbb_cc_region on public.client_complaints;
create trigger trg_bbb_cc_region before insert or update of client_id, company_id
  on public.client_complaints for each row execute function public.inherit_region_from_client_col();
drop trigger if exists trg_bbb_rp_region on public.renewal_pipeline;
create trigger trg_bbb_rp_region before insert or update of client_id, company_id
  on public.renewal_pipeline for each row execute function public.inherit_region_from_client_col();

-- ===========================================================================
-- 2. Cash cockpit (what the ledger supports today).
-- ===========================================================================

create or replace view public.cash_cockpit
  with (security_invoker = true) as
  with bal as (
    select je.company_id,
           sum(case when a.system_key = 'bank' then jl.debit - jl.credit else 0 end)
             + sum(case when a.parent_id in
                          (select id from public.chart_of_accounts where system_key = 'cash')
                        then jl.debit - jl.credit else 0 end)
             + sum(case when a.system_key = 'cash' then jl.debit - jl.credit else 0 end) as gross_cash,
           sum(case when a.system_key = 'bonus_reserve' then jl.debit - jl.credit else 0 end) as reserves
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     group by je.company_id
  ),
  outflow as (
    -- Average daily outflow over the last 90 days (expense debits paid in cash/bank).
    select je.company_id,
           round(sum(case a.account_type when 'expense' then jl.debit - jl.credit else 0 end)
                 / 90.0, 2) as avg_daily_outflow
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.entry_date >= current_date - 90
     group by je.company_id
  )
  select b.company_id,
         b.gross_cash,
         b.reserves,
         b.gross_cash - b.reserves               as available_after_reserves,
         o.avg_daily_outflow,
         case when coalesce(o.avg_daily_outflow, 0) > 0
              then round((b.gross_cash - b.reserves) / o.avg_daily_outflow, 1) end as days_runway
    from bal b left join outflow o on o.company_id = b.company_id;

-- ===========================================================================
-- 3. Per-department KPI dashboard: RAG rollup by seat.
-- ===========================================================================

create or replace view public.kpi_department_dashboard
  with (security_invoker = true) as
  select e.company_id,
         e.kpi_seat as department,
         e.branch_id,
         kv.period_month,
         count(*)                                   as kpis_scored,
         count(*) filter (where kv.rag = 'green')   as green,
         count(*) filter (where kv.rag = 'amber')   as amber,
         count(*) filter (where kv.rag = 'red')     as red
    from public.kpi_values kv
    join public.employees e on e.id = kv.employee_id
   where e.performance_enrolled and e.kpi_seat is not null
   group by e.company_id, e.kpi_seat, e.branch_id, kv.period_month;

-- ===========================================================================
-- 4. Regional scorecard — the RMD review page, one row per region.
--    Coverage, incidents, no-shows, profit & growth, DSO/aging, headcount.
--    Inter-region balance depends on §7 (not built) -> exposed as null.
-- ===========================================================================

create or replace view public.regional_scorecard
  with (security_invoker = true) as
  select b.company_id,
         b.id as branch_id,
         b.name as region_name,
         b.kind as region_kind,
         -- headcount (active field + office staff in the region)
         (select count(*) from public.employees e
           where e.branch_id = b.id and e.lifecycle_state = 'active') as active_headcount,
         -- incidents this year
         (select count(*) from public.incidents i
           where i.branch_id = b.id and extract(year from i.occurred_at) = extract(year from current_date))
           as incidents_ytd,
         -- no-shows last 30 days
         (select count(*) from public.no_show_events n
           where n.branch_id = b.id and n.event_date >= current_date - 30) as no_shows_30d,
         -- receivables outstanding (region's unpaid invoice balance)
         (select coalesce(sum(coalesce(i.total_due, i.invoice_amount) - i.amount_received), 0)
            from public.invoices i where i.branch_id = b.id
             and i.amount_received < coalesce(i.total_due, i.invoice_amount)) as receivables_outstanding,
         -- profit this year and prior (operating, after HO allocation)
         public.region_operating_profit(b.company_id, b.id, extract(year from current_date)::int) as profit_ytd,
         public.region_operating_profit(b.company_id, b.id, extract(year from current_date)::int - 1) as profit_prior_year,
         null::numeric as inter_region_balance   -- pending §7
    from public.branches b
   where b.active;

-- ===========================================================================
-- 5. Client service report source (spec §22): coverage delivered, visits done,
--    incidents handled, over a period. The PDF is generated from this.
-- ===========================================================================

create or replace function public.client_service_report(
  p_client_id uuid, p_start date, p_end date)
returns table (
  reports_submitted   integer,
  all_ok_reports      integer,
  exception_reports   integer,
  visits_completed    integer,
  incidents_total     integer,
  incidents_resolved  integer
) language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end),
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end and r.all_ok),
    (select count(*)::int from public.daily_ok_reports r
      where r.client_id = p_client_id and r.report_date between p_start and p_end and not r.all_ok),
    (select count(*)::int from public.supervisor_visits v
      where v.client_id = p_client_id and v.status = 'completed'
        and v.completed_at::date between p_start and p_end),
    (select count(*)::int from public.incidents i
      where i.client_id = p_client_id and i.occurred_at::date between p_start and p_end),
    (select count(*)::int from public.incidents i
      where i.client_id = p_client_id and i.occurred_at::date between p_start and p_end
        and i.status in ('resolved','closed'));
$$;
