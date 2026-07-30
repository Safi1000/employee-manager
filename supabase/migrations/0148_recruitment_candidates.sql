-- 0148: Recruitment intake (consolidation Workforce ▸ Recruitment).
--
-- A lightweight candidate pipeline that graduates a hire into an Employee.
-- One table, a status state-machine, and an optional link to the created
-- employee record. Vacancies are represented by the free-text position_applied
-- for now; a structured vacancy table can come later if needed.

create table if not exists public.recruitment_candidates (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  branch_id         uuid references public.branches(id) on delete set null,
  full_name         text not null,
  phone             text,
  email             text,
  cnic              text,
  position_applied  text,                              -- the vacancy / role
  source            text,                              -- walk-in | referral | agency | online | other
  status            text not null default 'applied',
  notes             text,
  hired_employee_id uuid references public.employees(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Pipeline states. 'hired' and 'rejected'/'withdrawn' are terminal.
alter table public.recruitment_candidates
  drop constraint if exists recruitment_candidates_status_chk;
alter table public.recruitment_candidates
  add constraint recruitment_candidates_status_chk
  check (status in ('applied','screening','interview','offer','hired','rejected','withdrawn'));

create index if not exists recruitment_candidates_company_idx
  on public.recruitment_candidates (company_id, status, created_at desc);

-- Auto-fill company_id from the caller's company on insert (house pattern).
drop trigger if exists trg_aaa_recruitment_fill_company on public.recruitment_candidates;
create trigger trg_aaa_recruitment_fill_company
  before insert on public.recruitment_candidates
  for each row execute function public.fill_company_id();

drop trigger if exists trg_recruitment_updated_at on public.recruitment_candidates;
create trigger trg_recruitment_updated_at
  before update on public.recruitment_candidates
  for each row execute function public.set_updated_at();

alter table public.recruitment_candidates enable row level security;

drop policy if exists "ssa_all" on public.recruitment_candidates;
create policy "ssa_all" on public.recruitment_candidates for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.recruitment_candidates;
create policy "company_members" on public.recruitment_candidates for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
