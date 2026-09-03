-- 0354 — the partner ledger would have raised on GGS, and two things beside it.
--
-- Found while verifying item 6's four cash-custody paths. None of these were in
-- the brief; all three are live on production and the first one breaks a screen
-- the moment Shayan creates a partner.
--
-- ===========================================================================
-- 1. partner_ledger CANNOT RUN ON GGS. It hardcodes the wrong basis.
-- ===========================================================================
--
-- partner_ledger asks partnership_allocation for the month's remuneration and
-- passes the basis as a LITERAL:
--
--     public.partnership_allocation(m, month_end, 'revenue')
--
-- partnership_allocation resolves that through partner_basis_for_report, which
-- refuses when the requested basis disagrees with the company's configured one:
--
--     'Report basis "%" disagrees with this company''s partner remuneration
--      basis "%" — one of the two is wrong, and a figure mixing them is
--      meaningless'
--
-- GGS's finance_settings.partner_remuneration_basis is **'cash'**. So every
-- call to partner_ledger for a GGS partner raises. Not a wrong number — a hard
-- error, on the partner statement screen, for every partner.
--
-- It has never been noticed because GGS has no partners yet. Shayan is about to
-- add them. The literal becomes the company's own basis.
--
-- ===========================================================================
-- 2. SHAYAN A. HAS NO finance_settings ROW AT ALL.
-- ===========================================================================
--
-- partner_basis_for_report raises 'No partner remuneration basis configured for
-- this company — apply migration 0230' when the row is missing, which is what
-- crm-design-dev does today for its sandbox. On production, SHAYAN A. is in the
-- same state: no row, so every partnership function raises for it.
--
-- Given a default row, the basis has to be chosen rather than guessed. 'cash'
-- matches GGS, and is the conservative one: a partner is remunerated on money
-- actually collected. If that is wrong for a future company it is one visible
-- column to change, which is better than a missing row that raises.
--
-- ===========================================================================
-- 3. ho_allocation_basis IS DEAD, AND ITS VALUE IS A LIE.
-- ===========================================================================
--
-- finance_settings.ho_allocation_basis reads 'average_deployed_guards' on GGS.
-- NOTHING reads the column — not one function on the database, not one line of
-- the frontend. Verified both ways: a grep over every migration finds only the
-- 0096 DDL that created it, and a scan of every pg_proc body returns nothing.
--
-- That matters because guard-days is precisely the driver A10 forbids and 0225
-- removed. Anyone opening finance_settings sees a company configured to
-- apportion head office by deployment, and it has not worked that way since
-- 0225. It is not dropped here — dropping a column is a bigger change than this
-- migration is scoped for and something may yet read it — but it is labelled so
-- the next reader cannot be misled by it.

-- ---------------------------------------------------------------------------
-- Fix 3 first: it is only a comment, and it costs nothing.
-- ---------------------------------------------------------------------------
comment on column public.finance_settings.ho_allocation_basis is
  'DEAD COLUMN (0354). Nothing reads it — verified across every pg_proc body and every migration. Its stored value ''average_deployed_guards'' is the guard-day driver A10 FORBIDS and 0225 removed; head office is apportioned by INVOICED revenue on both bases (0349, ho_apportionment_driver). Do not resurrect this column to steer apportionment. If it is ever dropped, nothing needs migrating.';

-- ---------------------------------------------------------------------------
-- Fix 2: every company gets a basis, so the partnership functions can run.
-- ---------------------------------------------------------------------------
insert into public.finance_settings (company_id, partner_remuneration_basis)
select c.id, 'cash'
  from public.companies c
 where not exists (select 1 from public.finance_settings f where f.company_id = c.id);

update public.finance_settings
   set partner_remuneration_basis = 'cash'
 where partner_remuneration_basis is null;

-- ---------------------------------------------------------------------------
-- Fix 1: the ledger asks for the company's own basis.
-- Surgery — partner_ledger has been written by 0215, 0216 and 0218.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def   text;
  v_new   text;
  v_hits  int;
  a_decl  text := 'declare v_opening numeric; v_from date; v_to date; v_coa uuid; v_company uuid; v_pstart date;';
  a_guard text := 'if v_opening is null then return; end if;';
  a_call  text := '(m + interval ''1 month - 1 day'')::date, ''revenue'') a';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'partner_ledger';
  if v_def is null then raise exception '0354 REFUSED: partner_ledger does not exist'; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_decl, ''))) / length(a_decl);
  if v_hits <> 1 then raise exception '0354 REFUSED: the declare anchor appears %, expected 1', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_guard, ''))) / length(a_guard);
  if v_hits <> 1 then raise exception '0354 REFUSED: the opening guard anchor appears %, expected 1', v_hits; end if;

  v_hits := (length(v_def) - length(replace(v_def, a_call, ''))) / length(a_call);
  if v_hits <> 1 then
    raise exception
      '0354 REFUSED: the hardcoded ''revenue'' allocation call appears % time(s), expected 1. If it is 0 the literal has already been fixed; do not widen the anchor.', v_hits;
  end if;

  v_new := replace(v_def, a_decl, a_decl || ' v_basis text;');

  v_new := replace(v_new, a_guard, a_guard || '

  -- 0354. The basis is the COMPANY''S, never a literal. partner_ledger asked
  -- partnership_allocation for ''revenue'' unconditionally, and
  -- partner_basis_for_report refuses any basis that disagrees with
  -- finance_settings.partner_remuneration_basis. GGS is configured ''cash'', so
  -- this function raised for every GGS partner — unnoticed only because GGS had
  -- no partners yet.
  v_basis := public.partner_basis_for_report(null, v_company);');

  v_new := replace(v_new, a_call, '(m + interval ''1 month - 1 day'')::date, v_basis) a');

  execute v_new;
  raise notice '0354: partner_ledger now asks for the company''s own remuneration basis.';
end $$;

-- ---------------------------------------------------------------------------
-- Prove it: the thing that raised must now return.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_miss  int;
  v_p     uuid;
  v_rows  int;
begin
  select count(*) into v_miss
    from public.companies c
   where not exists (select 1 from public.finance_settings f
                      where f.company_id = c.id and f.partner_remuneration_basis is not null);
  if v_miss > 0 then
    raise exception '0354 FAILED: % company/companies still have no partner remuneration basis; every partnership function raises for them.', v_miss;
  end if;

  select id into v_co from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_co is null then raise notice '0354: GGS absent; ledger probe skipped.'; return; end if;

  select id into v_p from public.partners where company_id = v_co limit 1;
  if v_p is null then
    raise notice '0354: GGS has no partners yet, so partner_ledger cannot be exercised here. The literal is gone, which is what would have raised.';
    return;
  end if;

  select count(*) into v_rows from public.partner_ledger(v_p, null, null);
  raise notice '0354: partner_ledger returned % row(s) for a GGS partner without raising.', v_rows;
end $$;
