-- ---------------------------------------------------------------------------
-- 0204 — per-client share overrides for a regional partner, and the per-client
--        breakdown the Partnership Report's partner drawer renders.
--
-- Until now a regional partner's share was one number applied to their whole
-- region: share% × (that region's Net Cash or Total Income, per the partner's
-- own basis). There was no way to say "this partner takes 20% of Client A but
-- only 10% of Client B", and no way to SEE which client contributed what — the
-- report showed one lump sum per partner with nothing behind it.
--
-- partner_client_shares stores only the exceptions. A client with no row keeps
-- the partner's headline profit_share_percent, so existing allocations are
-- unchanged by this migration.
-- ---------------------------------------------------------------------------
create table if not exists public.partner_client_shares (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  partner_id  uuid not null references public.partners(id) on delete cascade,
  client_id   uuid not null references public.clients(id)  on delete cascade,
  -- The share this partner takes of THIS client, overriding their headline %.
  share_percent numeric(6,3) not null check (share_percent >= 0 and share_percent <= 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint partner_client_shares_unique unique (partner_id, client_id)
);

create index if not exists partner_client_shares_partner_idx
  on public.partner_client_shares (partner_id);

alter table public.partner_client_shares enable row level security;

drop policy if exists company_members on public.partner_client_shares;
create policy company_members on public.partner_client_shares
  for all using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop policy if exists ssa_all on public.partner_client_shares;
create policy ssa_all on public.partner_client_shares
  for all using (is_ssa_unscoped()) with check (is_ssa_unscoped());

drop trigger if exists trg_aaa_pcs_fill_company on public.partner_client_shares;
create trigger trg_aaa_pcs_fill_company before insert on public.partner_client_shares
  for each row execute function fill_company_id();

drop trigger if exists trg_pcs_updated_at on public.partner_client_shares;
create trigger trg_pcs_updated_at before update on public.partner_client_shares
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- The breakdown behind one regional partner's number: one row per client in
-- their region, on the partner's OWN basis, with the share actually applied and
-- whether that share is an override or the headline one.
--
-- Equity partners get no rows: their share bites on the residual pool, which is
-- not attributable to any single client.
-- ---------------------------------------------------------------------------
create or replace function public.partner_client_breakdown(
  p_partner_id uuid,
  p_start      date,
  p_end        date
) returns table (
  client_id     uuid,
  client_name   text,
  client_code   text,
  basis         text,
  client_net    numeric,
  share_percent numeric,
  is_override   boolean,
  amount        numeric
) language sql stable security definer set search_path = public as $$
  with p as (
    select id, branch_id, profit_share_percent, coalesce(basis, 'revenue') as basis, scope
      from public.partners
     where id = p_partner_id
  ),
  cs as (
    select s.client_id, s.client_name, s.client_code, s.branch_id, s.net
      from p, lateral public.client_statement_loaded(p_start, p_end, p.basis) s
     where p.scope = 'BRANCH' and s.branch_id = p.branch_id
  )
  select cs.client_id, cs.client_name, cs.client_code,
         p.basis,
         cs.net,
         coalesce(o.share_percent, p.profit_share_percent) as share_percent,
         (o.share_percent is not null) as is_override,
         round(cs.net * coalesce(o.share_percent, p.profit_share_percent) / 100, 2) as amount
    from cs
    cross join p
    left join public.partner_client_shares o
           on o.partner_id = p.id and o.client_id = cs.client_id
   order by cs.client_name;
$$;

grant execute on function public.partner_client_breakdown(uuid, date, date) to authenticated;
