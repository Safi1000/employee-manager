-- 0519 — The ledger cutover date is a setting the database reads, not a date
-- written into functions.
--
-- NUMBER: written as 0519 on 2026-10-17. Claim it against
-- supabase_migrations.schema_migrations at apply time — another session applies
-- to this database too. If 0519 is taken, rename the FILE; never edit this text.
--
-- DECIDED 2026-10-17 by the user, for GUARDS AND GUIDES (PVT) LTD: the cutover
-- is 31 August 2026. Both partner opening balances are stated as at that date;
-- the opening batch is redated to it. Nothing dated on or before it is to be
-- itemised in the GL once the cutover posts; the opening carries it all.
--
-- WHAT READS IT (each a later migration, each separately authorised):
--   * the statutory remittance action — a payment for a month on or before the
--     cutover sends its unaccrued remainder to Opening Balance Equity, not cost;
--   * the pre-cutover carry rule — a document dated after the cutover whose
--     cost, by its own period, falls before it posts that share to Opening
--     Balance Equity, never into a pre-cutover month;
--   * operational cash — once the cutover has POSTED, a custodian's operational
--     balance is the opening plus documents dated after the cutover, and
--     nothing adds cash_locations.opening_balance on top of the GL;
--   * the period close — months on or before the cutover need no partnership
--     run to close.
--
-- TWO STATES, KEPT APART ON PURPOSE:
--   ledger_cutover_date(company)   the decided date, or null. Rules that route
--                                  NEW postings read this.
--   ledger_cutover_posted(company) the date is set AND an opening batch dated
--                                  that day has POSTED. Rules that stop reading
--                                  the pre-cutover documents read this, because
--                                  until the cutover runs those documents are
--                                  still what the GL holds.
--
-- SHAYAN_A has no cutover: no row, both functions answer null / false, and
-- every reader behaves exactly as before.
--
-- The date cannot be changed or removed once the cutover has posted, except in
-- a maintenance session: every carry and every archived entry was decided
-- against it.

create table if not exists public.ledger_cutovers (
  company_id   uuid primary key references public.companies(id),
  cutover_date date not null,
  decided      text not null,
  created_at   timestamptz not null default now()
);

alter table public.ledger_cutovers enable row level security;
drop policy if exists company_members_read on public.ledger_cutovers;
create policy company_members_read on public.ledger_cutovers
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.ledger_cutovers;
create policy ssa_read on public.ledger_cutovers
  for select using ((select public.is_ssa_unscoped()));

comment on table public.ledger_cutovers is
  '0519. One row per company that has cut its ledger over: the date on and before which nothing is itemised in the GL once the opening batch dated that day posts. Written by migration only. DECIDED for GGS 2026-10-17: 31 Aug 2026.';

create or replace function public.ledger_cutover_date(p_company_id uuid)
returns date
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return (select c.cutover_date from public.ledger_cutovers c where c.company_id = p_company_id);
end;
$function$;

create or replace function public.ledger_cutover_posted(p_company_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return exists (
    select 1
      from public.ledger_cutovers c
      join public.opening_balance_batches b
        on b.company_id = c.company_id and b.as_of_date = c.cutover_date and b.status = 'posted'
     where c.company_id = p_company_id);
end;
$function$;

revoke execute on function public.ledger_cutover_date(uuid), public.ledger_cutover_posted(uuid) from public, anon;
grant execute on function public.ledger_cutover_date(uuid), public.ledger_cutover_posted(uuid) to authenticated, service_role;

create or replace function public.guard_ledger_cutover()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if public.is_maintenance_session() then return coalesce(new, old); end if;
  if exists (select 1 from public.opening_balance_batches b
              where b.company_id = old.company_id and b.as_of_date = old.cutover_date and b.status = 'posted') then
    raise exception 'The ledger cutover for this company has posted (% ). Its date cannot be changed or removed: every carry and archived entry was decided against it.', old.cutover_date
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$function$;

revoke execute on function public.guard_ledger_cutover() from public, anon, authenticated;

drop trigger if exists trg_ledger_cutover_guard on public.ledger_cutovers;
create trigger trg_ledger_cutover_guard before update or delete on public.ledger_cutovers
  for each row execute function public.guard_ledger_cutover();

-- The decision, for the one company it was made for.
insert into public.ledger_cutovers (company_id, cutover_date, decided)
select c.id, date '2026-08-31',
       'DECIDED 2026-10-17 by the user: cutover 31 August 2026; both partner openings stated as at that date; the opening batch is redated to it.'
  from public.companies c
 where c.name = 'GUARDS AND GUIDES (PVT) LTD'
on conflict (company_id) do nothing;

-- ---------------------------------------------------------------------------
-- ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare v_ggs uuid; v_n int;
begin
  select id into v_ggs from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_ggs is null then raise exception '0519 FAILED: GUARDS AND GUIDES (PVT) LTD not found.'; end if;
  if public.ledger_cutover_date(v_ggs) is distinct from date '2026-08-31' then
    raise exception '0519 FAILED: GGS cutover reads %, expected 2026-08-31.', public.ledger_cutover_date(v_ggs);
  end if;
  -- The batch is a draft: the cutover is decided, not posted. Readers that stop
  -- reading pre-cutover documents must therefore change nothing yet.
  if public.ledger_cutover_posted(v_ggs) then
    raise exception '0519 FAILED: the GGS cutover reads as POSTED; the opening batch is expected to be a draft.';
  end if;
  select count(*) into v_n from public.ledger_cutovers;
  if v_n <> 1 then raise exception '0519 FAILED: % cutover rows, expected exactly one (GGS).', v_n; end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0519 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
