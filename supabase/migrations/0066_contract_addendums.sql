-- 0064: Contract Addendums (Phase 2).
--
-- An addendum records a change to a contract's committed headcount or rate that
-- takes effect from a date, without mutating the original contract_lines base.
-- Effective committed count for a category on a date =
--   base committed_count (contract_lines)
--   + Σ addendum count_deltas for that line/category where effective_from <= date.
--
-- Depends on 0063 (contract_lines + contract_line_category).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'addendum_change_type') then
    create type addendum_change_type as enum ('ADD_HEADCOUNT', 'REDUCE_HEADCOUNT', 'RATE_CHANGE');
  end if;
  if not exists (select 1 from pg_type where typname = 'addendum_source') then
    create type addendum_source as enum ('SIGNED_CONTRACT', 'EMAIL', 'VERBAL', 'OTHER');
  end if;
end$$;

create table if not exists public.contract_addendums (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  contract_id       uuid not null references public.contracts(id) on delete cascade,
  -- Null contract_line_id means the addendum introduces a NEW line; `category`
  -- then names which category it adds to.
  contract_line_id  uuid references public.contract_lines(id) on delete set null,
  category          contract_line_category,
  change_type       addendum_change_type not null,
  count_delta       integer not null default 0,
  new_rate          numeric(14,2),
  effective_from    date not null,
  source            addendum_source not null default 'OTHER',
  reference         text,
  -- Optional uploaded reference document (same Drive pattern as contracts).
  drive_file_id     text,
  drive_view_url    text,
  reference_file_name text,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_contract_addendums_company  on public.contract_addendums(company_id);
create index if not exists idx_contract_addendums_contract on public.contract_addendums(contract_id);
create index if not exists idx_contract_addendums_line     on public.contract_addendums(contract_line_id);
create index if not exists idx_contract_addendums_eff      on public.contract_addendums(effective_from);

drop trigger if exists trg_aaa_contract_addendums_fill_company on public.contract_addendums;
create trigger trg_aaa_contract_addendums_fill_company
  before insert on public.contract_addendums
  for each row execute function public.fill_company_id();

drop trigger if exists trg_contract_addendums_updated_at on public.contract_addendums;
create trigger trg_contract_addendums_updated_at
  before update on public.contract_addendums
  for each row execute function public.touch_updated_at();

alter table public.contract_addendums enable row level security;

drop policy if exists "ssa_all" on public.contract_addendums;
create policy "ssa_all" on public.contract_addendums for all
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());

drop policy if exists "company_members" on public.contract_addendums;
create policy "company_members" on public.contract_addendums for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Audit trigger — addendum creates/edits show up in the Audit Log automatically.
drop trigger if exists trg_zzz_contract_addendums_audit on public.contract_addendums;
create trigger trg_zzz_contract_addendums_audit
  after insert or update or delete on public.contract_addendums
  for each row execute function public.log_audit_change();
