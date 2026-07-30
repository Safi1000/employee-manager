-- 0149: Daily report export log (Operations ▸ Daily Reports).
--
-- Completes "date-wise client report → auto-PDF + record": each time a daily
-- operations report PDF is generated, a compact immutable record is written
-- here (the counts snapshot + who/when). The PDF itself is generated client-side
-- and downloaded; this is the durable audit trail of what was reported when.

create table if not exists public.daily_report_exports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  report_date   date not null,
  total_posts   integer not null default 0,
  reported      integer not null default 0,
  silent        integer not null default 0,
  exceptions    integer not null default 0,
  generated_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists daily_report_exports_company_idx
  on public.daily_report_exports (company_id, created_at desc);

drop trigger if exists trg_aaa_daily_report_exports_fill_company on public.daily_report_exports;
create trigger trg_aaa_daily_report_exports_fill_company
  before insert on public.daily_report_exports
  for each row execute function public.fill_company_id();

alter table public.daily_report_exports enable row level security;

drop policy if exists "ssa_all" on public.daily_report_exports;
create policy "ssa_all" on public.daily_report_exports for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.daily_report_exports;
create policy "company_members" on public.daily_report_exports for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
