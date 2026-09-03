-- 0345 — an orphaned leaf account is retired, never removed.
--
-- WHAT SHAYAN SAW. He created a partner on GGS, deleted it, and its capital
-- account stayed in the Chart of Accounts. It is still there:
--
--   GGS   3000.01  'Shujaat Mehmood — Capital'   0 journal lines, no partner row
--   dev   1000.03  'Shayan (partner)'            0 journal lines, no owner row
--
-- One on each database. Both have never held a line, and both have no owning
-- record. They are clutter.
--
-- THE RULE, AND WHY IT IS DEACTIVATION AND NOT DELETION.
--
--   * An account that HAS EVER held a journal line SURVIVES. History cannot be
--     removed. This is already true at the schema level and this migration does
--     not weaken it: journal_lines.account_id is ON DELETE RESTRICT, so the
--     database physically refuses to drop such an account. The trigger below
--     tests the same condition BEFORE trying, so the common case is a quiet
--     no-op rather than a caught error.
--   * An account that has NEVER held one, whose owning record is gone, is
--     DEACTIVATED — active = false. Not deleted.
--
-- Deactivating rather than deleting, even though nothing references it: the
-- account code is allocated from a per-company sequence (1000.NN, 1010.NN,
-- 3000.NN). Deleting 3000.01 lets the next partner take 3000.01, and now two
-- different people share a code in the audit log and in anything that recorded
-- the code rather than the id. A retired code stays taken. That costs one row.
--
-- WHERE IT IS ENFORCED. In the database, where the leaves are created:
-- ensure_partner_capital_account and ensure_cash_location_account create them
-- on INSERT, so the retirement belongs on DELETE beside them, not in a screen.
--
-- TWO TRIGGERS COVER THREE OWNERS. cash_locations.bank_account_id is
-- ON DELETE CASCADE, so deleting a bank_account deletes its mirror
-- cash_location, which fires the cash_locations trigger. A separate
-- bank_accounts trigger would be a second path to the same row. The mirror is
-- the thing that holds coa_account_id, so the mirror is where this belongs.

create or replace function public.retire_orphaned_leaf_account(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_lines int;
  v_code  text;
begin
  if p_account_id is null then return; end if;

  select count(*) into v_lines from public.journal_lines where account_id = p_account_id;

  -- Has held a line: it survives, active and untouched. This is the whole
  -- point of the rule and it is checked first.
  if v_lines > 0 then return; end if;

  -- Still owned by something else (a partner and a cash location can, in
  -- principle, point at the same account). Not an orphan.
  if exists (select 1 from public.partners       where coa_account_id = p_account_id)
  or exists (select 1 from public.cash_locations where coa_account_id = p_account_id) then
    return;
  end if;

  update public.chart_of_accounts
     set active = false,
         notes  = coalesce(notes || ' | ', '') ||
                  'Retired ' || to_char(now(), 'YYYY-MM-DD') ||
                  ': owning record deleted, account never held a journal line (0345).'
   where id = p_account_id and active
   returning account_code into v_code;

  if v_code is not null then
    raise notice '0345: retired orphaned leaf account %', v_code;
  end if;
end;
$fn$;

comment on function public.retire_orphaned_leaf_account(uuid) is
  '0345: deactivates an auto-created leaf account whose owning partner / bank account / cash location has been deleted, PROVIDED it has never held a journal line. An account with history is left active and untouched. No tenant guard: the parameter is an account id reached only from a row the caller has just deleted under RLS, and the function neither reads nor writes across companies.';

-- ---------------------------------------------------------------------------
-- The two triggers.
-- ---------------------------------------------------------------------------
create or replace function public.retire_leaf_on_owner_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  perform public.retire_orphaned_leaf_account(old.coa_account_id);
  return old;
end;
$fn$;

drop trigger if exists trg_zzz_partner_leaf_retire on public.partners;
create trigger trg_zzz_partner_leaf_retire
  after delete on public.partners
  for each row execute function public.retire_leaf_on_owner_delete();

drop trigger if exists trg_zzz_cash_location_leaf_retire on public.cash_locations;
create trigger trg_zzz_cash_location_leaf_retire
  after delete on public.cash_locations
  for each row execute function public.retire_leaf_on_owner_delete();

-- ---------------------------------------------------------------------------
-- Backfill. Every leaf already orphaned, on whichever database this runs.
-- ---------------------------------------------------------------------------
do $$
declare
  v_n int := 0;
  r   record;
begin
  for r in
    select a.id, a.account_code, a.account_name, c.name as company
      from public.chart_of_accounts a
      join public.companies c on c.id = a.company_id
     where a.active
       and a.system_key is null
       and (a.account_code like '1000.%' or a.account_code like '1010.%' or a.account_code like '3000.%')
       and not exists (select 1 from public.journal_lines   l where l.account_id     = a.id)
       and not exists (select 1 from public.partners        p where p.coa_account_id = a.id)
       and not exists (select 1 from public.cash_locations  x where x.coa_account_id = a.id)
  loop
    update public.chart_of_accounts
       set active = false,
           notes  = coalesce(notes || ' | ', '') ||
                    'Retired ' || to_char(now(), 'YYYY-MM-DD') ||
                    ': owning record deleted, account never held a journal line (0345 backfill).'
     where id = r.id;
    v_n := v_n + 1;
    raise notice '0345 backfill: % — % (%)', r.account_code, r.account_name, r.company;
  end loop;
  raise notice '0345: retired % orphaned leaf account(s).', v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Prove the trigger fires and, more importantly, that it REFUSES to retire an
-- account with history. A rollback probe: nothing below survives.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co    uuid;
  v_keep  uuid;
  v_drop  uuid;
  v_loc_k uuid;
  v_loc_d uuid;
  v_je    uuid;
  v_k_act boolean;
  v_d_act boolean;
begin
  select id into v_co from public.companies order by created_at limit 1;
  if v_co is null then raise notice '0345: no company to probe against; skipped.'; return; end if;

  begin
    insert into public.chart_of_accounts
      (company_id, account_code, account_name, account_type, normal_side, active, system_account, is_control)
    values (v_co, '1000.zz1', '0345 probe keep', 'asset', 'debit', true, false, false)
    returning id into v_keep;

    insert into public.chart_of_accounts
      (company_id, account_code, account_name, account_type, normal_side, active, system_account, is_control)
    values (v_co, '1000.zz2', '0345 probe drop', 'asset', 'debit', true, false, false)
    returning id into v_drop;

    insert into public.cash_locations (company_id, name, location_type, opening_balance, is_active, coa_account_id)
    values (v_co, '0345 probe keep', 'CUSTODIAN', 0, true, v_keep) returning id into v_loc_k;
    insert into public.cash_locations (company_id, name, location_type, opening_balance, is_active, coa_account_id)
    values (v_co, '0345 probe drop', 'CUSTODIAN', 0, true, v_drop) returning id into v_loc_d;

    -- Give ONLY the first one history.
    insert into public.journal_entries (company_id, entry_date, description, source_table, manual)
    values (v_co, current_date, '0345 probe', 'probe', true) returning id into v_je;
    insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
    values (v_je, v_keep, 1, 0), (v_je, v_keep, 0, 1);

    delete from public.cash_locations where id in (v_loc_k, v_loc_d);

    select active into v_k_act from public.chart_of_accounts where id = v_keep;
    select active into v_d_act from public.chart_of_accounts where id = v_drop;

    if not v_k_act then
      raise exception '0345 FAILED: an account carrying a journal line was retired. History must survive its owner.';
    end if;
    if v_d_act then
      raise exception '0345 FAILED: an orphaned leaf with no journal lines stayed active. The trigger did not fire.';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0345: probe passed — history survives, clutter retires.';
  end;
end $$;
