-- 0169: Daily Reports moves from POSTS to CLIENTS.
--
-- The page used to ask for a post, a required count, a present count and an
-- exception note. It now asks one thing per client: a free-text "Details" note
-- for the day, which is what the exported PDF is built from.
--
-- One row per (company, client, day). The day is part of the key, so a new day
-- simply has no rows yet and every Details box starts empty — there is nothing
-- to clear and no job to run. It also makes past days addressable: pick a date
-- and you read back exactly what was written on it.
create table if not exists public.daily_client_reports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  report_date date not null default current_date,
  details     text,
  updated_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint daily_client_reports_unique unique (company_id, client_id, report_date)
);

-- The page always reads a whole day at a time.
create index if not exists daily_client_reports_day_idx
  on public.daily_client_reports (company_id, report_date);

alter table public.daily_client_reports enable row level security;

drop policy if exists company_members on public.daily_client_reports;
create policy company_members on public.daily_client_reports
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.daily_client_reports;
create policy ssa_all on public.daily_client_reports
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

-- Same trigger set every scoped table carries: company stamped on the way in,
-- updated_at kept honest, changes audited. The aaa/zzz prefixes preserve the
-- firing order (company filled before anything reads it, audit written last).
drop trigger if exists trg_aaa_daily_client_reports_fill_company on public.daily_client_reports;
create trigger trg_aaa_daily_client_reports_fill_company
before insert on public.daily_client_reports
for each row execute function public.fill_company_id();

drop trigger if exists trg_daily_client_reports_updated_at on public.daily_client_reports;
create trigger trg_daily_client_reports_updated_at
before update on public.daily_client_reports
for each row execute function public.touch_updated_at();

drop trigger if exists trg_zzz_daily_client_reports_audit on public.daily_client_reports;
create trigger trg_zzz_daily_client_reports_audit
after insert or update or delete on public.daily_client_reports
for each row execute function public.log_audit_change();
