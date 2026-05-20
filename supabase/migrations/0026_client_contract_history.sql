-- ============================================================================
-- Contract history log: every time a client contract is renewed, the prior
-- (start, end) pair is snapshotted here so future-you can see the chain of
-- renewals without losing the active dates on the clients row.
-- ============================================================================

create table if not exists public.client_contract_history (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  contract_start date,
  contract_end date,
  notes text,
  renewed_at timestamptz not null default now(),
  renewed_by uuid references auth.users(id) on delete set null
);

create index if not exists client_contract_history_client_idx
  on public.client_contract_history(client_id, renewed_at desc);

alter table public.client_contract_history enable row level security;

drop policy if exists "ssa_all" on public.client_contract_history;
create policy "ssa_all" on public.client_contract_history for all
  using (public.is_super_super_admin()) with check (public.is_super_super_admin());

drop policy if exists "company_members" on public.client_contract_history;
create policy "company_members" on public.client_contract_history for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Auto-stamp company_id on insert if missing (mirrors the pattern used by
-- other tenant tables — see 0003_auto_company_id_on_insert.sql).
create or replace function public.client_contract_history_set_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.company_id is null then
    select c.company_id into new.company_id
      from public.clients c
     where c.id = new.client_id;
  end if;
  if new.renewed_by is null then
    new.renewed_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_client_contract_history_set_company on public.client_contract_history;
create trigger trg_client_contract_history_set_company
  before insert on public.client_contract_history
  for each row execute function public.client_contract_history_set_company();
