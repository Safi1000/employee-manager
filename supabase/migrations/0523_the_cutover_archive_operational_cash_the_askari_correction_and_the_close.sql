-- 0523 — What the cutover itself needs in place: the archive it moves
-- pre-cutover entries into, operational cash that stops double-counting once
-- the cutover posts, Askari's stored balance corrected, and months on or before
-- the cutover closable without a partnership run.
--
-- NUMBER: written as 0523 on 2026-10-17. Claim it against
-- supabase_migrations.schema_migrations at apply time; rename the FILE if taken.
-- NEEDS 0519 (ledger_cutover_date / ledger_cutover_posted).
--
-- ===========================================================================
-- 1. THE ARCHIVE
-- ===========================================================================
-- journal_entries_archive and journal_lines_archive: the same columns as the
-- live tables, plus when and why. The cutover (a later migration, not this one)
-- copies the 442 GGS entries dated on or before 31 Aug here before removing them
-- from the GL, so the record of what left is kept. Nothing is archived here.
--
-- ===========================================================================
-- 2. OPERATIONAL CASH — replaces the withdrawn cash-zeroing design
-- ===========================================================================
-- custodian_held_operational() computed operational = cash_locations.
-- opening_balance + EVERY document of any date, and the GL side = the same
-- opening field + the GL. The opening field was typed on 2 Sep AFTER the August
-- advances, so the operational side counts those advances twice; and once the
-- cutover journalises the opening, adding the field to the GL counts the
-- opening twice. Zeroing the field (the withdrawn design) would have broken
-- the operational side instead.
-- From the moment the cutover POSTS (ledger_cutover_posted):
--   operational = the opening field + documents dated AFTER the cutover
--   GL side     = the GL alone (the opening is in it)
-- and cash_location_balances stops adding the field on top of the GL.
-- Until it posts, both read exactly as before — asserted below.
--
-- ===========================================================================
-- 3. ASKARI +26,000
-- ===========================================================================
-- The advance of 26,000 paid to Bismillah Jan (GGS-00010) on 30 Aug from Askari
-- was entered on 16 Sep and moved Askari's stored balance then. The opening of
-- 3,619,821 was typed on 2 Sep, after the advance had been paid — DECIDED
-- 2026-10-17 on the entry dates (the user is checking the statement). So the
-- stored balance has been 26,000 LOW since 16 Sep. One 'adjustment' movement of
-- +26,000 through apply_money_delta, referencing the advance; nothing else.
-- Expected effect on the checks, named so it is not mistaken for a defect:
-- bank_control_equals_bank_accounts moves by 26,000 (the GL still holds the
-- August advance until the cutover archives it, at which point it comes back);
-- bank_accounts_equal_transaction_deltas keeps passing (both sides move).
--
-- ===========================================================================
-- 4. THE CLOSE
-- ===========================================================================
-- require_partnership_run_before_close (0358) refuses to close a month with no
-- POSTED partnership run. A month on or before the cutover has no P&L in the GL
-- and no run to post, so it could never be closed — and closing July and
-- August is what stops a pre-cutover document being edited and re-posted into
-- them. Months on or before the cutover need no run. require_opening_batch_
-- before_first_close still applies: the first close needs a posted opening.

do $$
begin
  if to_regprocedure('public.ledger_cutover_posted(uuid)') is null then
    raise exception '0523 REFUSED: ledger_cutover_posted() does not exist. Apply 0519 (the cutover date setting) first.';
  end if;
end $$;

create temp table t0523_red on commit drop as
select c.id co, c.name, lc.check_name, lc.expected, lc.actual, lc.difference, lc.passed
  from public.companies c, public.ledger_checks(c.id) lc;

create temp table t0523_cash on commit drop as
select c.id co, o.cash_location_id, o.operational, o.gl
  from public.companies c, public.custodian_held_operational(c.id) o;

create temp table t0523_clb on commit drop as
select cash_location_id, balance from public.cash_location_balances;

-- ---------------------------------------------------------------------------
-- 1. The archive.
-- ---------------------------------------------------------------------------
create table if not exists public.journal_entries_archive (like public.journal_entries including defaults);
alter table public.journal_entries_archive
  add column if not exists archived_at    timestamptz not null default now(),
  add column if not exists archive_reason text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.journal_entries_archive'::regclass and contype = 'p') then
    alter table public.journal_entries_archive add primary key (id);
  end if;
end $$;

create table if not exists public.journal_lines_archive (like public.journal_lines including defaults);
alter table public.journal_lines_archive
  add column if not exists archived_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.journal_lines_archive'::regclass and contype = 'p') then
    alter table public.journal_lines_archive add primary key (id);
  end if;
end $$;
create index if not exists journal_lines_archive_entry on public.journal_lines_archive (journal_entry_id);

alter table public.journal_entries_archive enable row level security;
alter table public.journal_lines_archive enable row level security;
drop policy if exists company_members_read on public.journal_entries_archive;
create policy company_members_read on public.journal_entries_archive
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.journal_entries_archive;
create policy ssa_read on public.journal_entries_archive
  for select using ((select public.is_ssa_unscoped()));
drop policy if exists company_members_read on public.journal_lines_archive;
create policy company_members_read on public.journal_lines_archive
  for select using (exists (select 1 from public.journal_entries_archive e
                             where e.id = journal_lines_archive.journal_entry_id
                               and e.company_id = (select public.current_company_id())));
drop policy if exists ssa_read on public.journal_lines_archive;
create policy ssa_read on public.journal_lines_archive
  for select using ((select public.is_ssa_unscoped()));

comment on table public.journal_entries_archive is
  '0523. Journal entries removed from the GL by a ledger cutover, kept as they were. Written only by the cutover migration, in a maintenance session. Read-only to company members.';
comment on table public.journal_lines_archive is
  '0523. The lines of journal_entries_archive. Written only by the cutover migration.';

-- ---------------------------------------------------------------------------
-- 2. Operational cash (surgery on custodian_held_operational; eight authors).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.surg0523(p_fn text, p_key text, p_old text, p_new text, p_marker text)
returns void language plpgsql as $f$
declare v_def text; v_hits int;
begin
  v_def := pg_get_functiondef(p_fn::regprocedure);
  if position(p_marker in v_def) > 0 then
    raise notice '0523: % [%] already applied.', p_fn, p_key;
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  if v_hits <> 1 then
    raise exception '0523 REFUSED: in %, anchor [%] appears % time(s), expected 1.', p_fn, p_key, v_hits;
  end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$decl$k$,
  $a$#variable_conflict use_column
begin$a$,
  $b$#variable_conflict use_column
declare
  v_cut    date    := public.ledger_cutover_date(p_company_id);                        -- 0523
  v_posted boolean := coalesce(public.ledger_cutover_posted(p_company_id), false);     -- 0523: the opening is journalised
begin$b$,
  $m$-- 0523: the opening is journalised$m$);

select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$t_in$k$,
  $a$where t.company_id = p_company_id and t.to_location_id = l.id), 0)$a$,
  $b$where t.company_id = p_company_id and t.to_location_id = l.id and (not v_posted or t.date > v_cut)), 0)$b$,
  $m$t.to_location_id = l.id and (not v_posted or t.date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$t_out$k$,
  $a$where t.company_id = p_company_id and t.from_location_id = l.id), 0)$a$,
  $b$where t.company_id = p_company_id and t.from_location_id = l.id and (not v_posted or t.date > v_cut)), 0)$b$,
  $m$t.from_location_id = l.id and (not v_posted or t.date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$receipts$k$,
  $a$where p.payment_mode = 'Cash' and p.custodian_location_id = l.id), 0)$a$,
  $b$where p.payment_mode = 'Cash' and p.custodian_location_id = l.id and (not v_posted or p.payment_date > v_cut)), 0)$b$,
  $m$(not v_posted or p.payment_date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$expenses$k$,
  $a$where e.custodian_location_id = l.id), 0)$a$,
  $b$where e.custodian_location_id = l.id and (not v_posted or e.expense_date > v_cut)), 0)$b$,
  $m$(not v_posted or e.expense_date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$vendor$k$,
  $a$where vp.paid_via = 'Cash' and vp.custodian_location_id = l.id), 0)$a$,
  $b$where vp.paid_via = 'Cash' and vp.custodian_location_id = l.id and (not v_posted or vp.paid_on > v_cut)), 0)$b$,
  $m$(not v_posted or vp.paid_on > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$advances$k$,
  $a$where a.payment_mode = 'Cash' and a.custodian_location_id = l.id), 0)$a$,
  $b$where a.payment_mode = 'Cash' and a.custodian_location_id = l.id and (not v_posted or a.advance_date > v_cut)), 0)$b$,
  $m$(not v_posted or a.advance_date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$cheques$k$,
  $a$and c.custodian_location_id = l.id), 0)$a$,
  $b$and c.custodian_location_id = l.id and (not v_posted or coalesce(c.cleared_at::date, c.cheque_date) > v_cut)), 0)$b$,
  $m$(not v_posted or coalesce(c.cleared_at::date, c.cheque_date) > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$bank$k$,
  $a$and b.reference_id = l.id::text), 0)$a$,
  $b$and b.reference_id = l.id::text and (not v_posted or b.created_at::date > v_cut)), 0)$b$,
  $m$(not v_posted or b.created_at::date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$partner$k$,
  $a$where pe.payment_method = 'CASH' and pe.cash_location_id = l.id), 0)$a$,
  $b$where pe.payment_method = 'CASH' and pe.cash_location_id = l.id and (not v_posted or pe.date > v_cut)), 0)$b$,
  $m$(not v_posted or pe.date > v_cut)$m$);
select pg_temp.surg0523($f$public.custodian_held_operational(uuid)$f$, $k$gl$k$,
  $a$           l.opening_balance
         + coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl$a$,
  $b$           (case when v_posted then 0 else l.opening_balance end)  -- 0523: once posted the opening is in the GL
         + coalesce((select sum(jl.debit - jl.credit) from public.journal_lines jl$b$,
  $m$-- 0523: once posted the opening is in the GL$m$);

-- cash_location_balances: restated behind a digest precondition (the view has
-- eight authors; a view cannot be amended by surgery, so its current text must
-- be the text this replaces, or nothing happens).
do $$
declare v_md5 text := md5(pg_get_viewdef('public.cash_location_balances'::regclass));
begin
  if position('0523' in coalesce(obj_description('public.cash_location_balances'::regclass, 'pg_class'), '')) > 0 then
    raise notice '0523: cash_location_balances already restated.';
    return;
  end if;
  if v_md5 <> 'b9a3c6d21ea8ad361c555300d86a0111' then
    raise exception '0523 REFUSED: cash_location_balances is not the definition this restates (md5 %). An unrecorded edit; nothing replaced.', v_md5;
  end if;
  execute $v$
    create or replace view public.cash_location_balances with (security_invoker = true) as
    select cl.id as cash_location_id,
           cl.company_id,
           cl.name,
           cl.location_type,
           cl.branch_id,
           b.name as region_name,
           cl.coa_account_id,
           (case when exists (select 1 from public.ledger_cutovers lc
                                join public.opening_balance_batches ob
                                  on ob.company_id = lc.company_id and ob.as_of_date = lc.cutover_date and ob.status = 'posted'
                               where lc.company_id = cl.company_id)
                 then 0 else cl.opening_balance end)
             + coalesce(sum(jl.debit - jl.credit), 0::numeric) as balance
      from public.cash_locations cl
      left join public.branches b on b.id = cl.branch_id
      left join public.journal_lines jl on jl.account_id = cl.coa_account_id
     group by cl.id, cl.company_id, cl.name, cl.location_type, cl.branch_id, b.name, cl.coa_account_id, cl.opening_balance
  $v$;
  comment on view public.cash_location_balances is
    '0523: once the ledger cutover has posted, the opening is in the GL and opening_balance is no longer added on top of it.';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Askari +26,000.
-- ---------------------------------------------------------------------------
do $$
declare
  v_adv  constant text := 'a8e75eb8-56a1-404f-b177-4e1642ef71a2';
  v_co   uuid;
  v_bank uuid;
begin
  if exists (select 1 from public.bank_transactions where kind = 'adjustment' and reference_id = v_adv) then
    raise notice '0523: the Askari correction is already recorded.';
    return;
  end if;
  select t.company_id, t.bank_account_id into v_co, v_bank
    from public.bank_transactions t
   where t.reference_id = v_adv and t.kind = 'advance' and t.account_delta = -26000;
  if v_bank is null or (select bank_name from public.bank_accounts where id = v_bank) not ilike 'Askari%' then
    raise exception '0523 REFUSED: the 16 Sep Askari movement of -26,000 for advance % was not found as expected.', v_adv;
  end if;
  perform public.apply_money_delta(
    v_co, 'Bank', v_bank, 26000, 'adjustment',
    'Correction (0523): the 30 Aug advance to Bismillah Jan (GGS-00010) was already inside the 31 Aug opening of 3,619,821; its 16 Sep movement counted it twice.',
    v_adv);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The close (surgery on require_partnership_run_before_close; one author).
-- ---------------------------------------------------------------------------
select pg_temp.surg0523($f$public.require_partnership_run_before_close()$f$, $k$close$k$,
  $a$  if v_partners = 0 then return new; end if;$a$,
  $b$  if v_partners = 0 then return new; end if;

  -- 0523: a month on or before the ledger cutover has no P&L in the GL and no
  -- run to post. It closes without one.
  if public.ledger_cutover_date(new.company_id) is not null
     and new.period_month <= date_trunc('month', public.ledger_cutover_date(new.company_id))::date then
    return new;
  end if;$b$,
  $m$-- 0523: a month on or before the ledger cutover$m$);

-- ---------------------------------------------------------------------------
-- 5. ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
declare v_bad int; v_txt text; v_d numeric; v_o numeric;
begin
  -- 5a. The cutover has not posted, so operational cash and the location
  --     balances read exactly what they read before.
  select count(*) into v_bad
    from t0523_cash b
    left join (select c.id co, o.cash_location_id, o.operational, o.gl
                 from public.companies c, public.custodian_held_operational(c.id) o) a
      on a.co = b.co and a.cash_location_id = b.cash_location_id
   where a.cash_location_id is null or a.operational is distinct from b.operational or a.gl is distinct from b.gl;
  if v_bad > 0 then raise exception '0523 FAILED: operational cash moved for % location(s) before the cutover posted.', v_bad; end if;

  select count(*) into v_bad
    from t0523_clb b left join public.cash_location_balances a on a.cash_location_id = b.cash_location_id
   where a.cash_location_id is null or a.balance is distinct from b.balance;
  if v_bad > 0 then raise exception '0523 FAILED: cash_location_balances moved for % location(s) before the cutover posted.', v_bad; end if;

  -- 5b. The Askari correction moved the two bank checks exactly as named, and
  --     nothing else.
  select a.difference - o.difference into v_d
    from (select c.id co, lc.check_name, lc.difference from public.companies c, public.ledger_checks(c.id) lc) a
    join t0523_red o on o.co = a.co and o.check_name = a.check_name
   where a.check_name = 'bank_control_equals_bank_accounts' and o.name = 'GUARDS AND GUIDES (PVT) LTD';
  if v_d is distinct from -26000 and v_d is distinct from 0 then
    raise exception '0523 FAILED: bank_control_equals_bank_accounts difference moved by %, expected -26,000 (or 0 on replay).', v_d;
  end if;
  if exists (select 1 from public.companies c, public.ledger_checks(c.id) lc
              where lc.check_name = 'bank_accounts_equal_transaction_deltas'
                and not lc.passed
                and exists (select 1 from t0523_red o where o.co = c.id and o.check_name = lc.check_name and o.passed)) then
    raise exception '0523 FAILED: bank_accounts_equal_transaction_deltas turned red.';
  end if;

  select count(*), string_agg(a.name || ' ' || a.check_name || ' ' || coalesce(o.difference::text, 'new') || '->' || a.difference::text, '; ')
    into v_bad, v_txt
    from (select c.id co, c.name, lc.check_name, lc.difference, lc.passed
            from public.companies c, public.ledger_checks(c.id) lc) a
    left join t0523_red o on o.co = a.co and o.check_name = a.check_name
   where a.check_name not in ('bank_control_equals_bank_accounts', 'bank_accounts_equal_transaction_deltas', 'bank_per_account_gl_equals_operational')
     and (o.check_name is null or o.passed is distinct from a.passed or o.difference is distinct from a.difference);
  if v_bad > 0 then raise exception '0523 FAILED: an unrelated check moved: %', v_txt; end if;

  -- 5c. The close skips the run only for months on or before the cutover.
  if position('0523: a month on or before the ledger cutover' in pg_get_functiondef('public.require_partnership_run_before_close()'::regprocedure)) = 0 then
    raise exception '0523 FAILED: the close still requires a run for pre-cutover months.';
  end if;
  if exists (select 1 from public.journal_entries_archive) then
    raise exception '0523 FAILED: the archive is expected to be empty; this migration archives nothing.';
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0523 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
