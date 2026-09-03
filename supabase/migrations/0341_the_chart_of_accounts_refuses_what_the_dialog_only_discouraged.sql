-- 0341 — a recommendation is not a control. The chart of accounts refuses.
--
-- WHAT HAPPENED
--
-- The Chart of Accounts edit dialog let any account be renamed, retyped and
-- reparented. Shayan reparented **1000 Cash in Hand under 1010 Bank Accounts**
-- on GUARDS AND GUIDES and it saved. The dialog said "System account — rename
-- is fine; changing type is not recommended" and nothing enforced it.
--
-- Cash is not a bank account. That edit puts cash and bank in one control
-- subtree, which is the routing 0262, 0271 and 0276 exist to keep apart. It
-- was set back by hand.
--
-- The dialog was the only thing standing in the way, and chart_of_accounts has
-- more than one writer — the app, seed_company_defaults,
-- sync_bank_account_cash_location, and anyone with a SQL editor. A rule that
-- lives in one writer is not a rule.
--
-- WHICH ACCOUNTS ARE "SYSTEM", MEASURED RATHER THAN ASSUMED
--
-- The brief said `system_account = true`. On crm-design that column is TRUE on
-- **112 of 112** accounts — including the leaves the application creates by
-- itself for each bank account and each cash custodian. Keying the strict rule
-- to it would freeze the entire chart of accounts, including rows the app
-- maintains automatically, which is a different and much larger decision than
-- the one being made here.
--
-- The column that actually separates them is `system_key`, and the split is
-- total, in both directions:
--
--   system_key IS NOT NULL   105 accounts, and every one is TOP-LEVEL
--                            (the seeded controls: 1000, 1010, 1100, 2100 …)
--   system_key IS NULL         7 accounts, and every one HAS A PARENT
--                            (1000.01, 1000.02 custodians; 1010.01-.04 banks;
--                             3000.01 partner equity — created by the app)
--
-- So the strict rule below is keyed on `system_key is not null`: those are the
-- system CONTROL accounts, which is what the brief describes ("system control
-- accounts with children"). The seven leaves are ordinary data with an
-- automatic mirror, and they are governed by the posted-lines rules like
-- anything else. THIS IS A DEVIATION FROM THE LITERAL INSTRUCTION AND IT IS
-- STATED HERE RATHER THAN BURIED: keying on system_account would have made
-- every account in the system immutable.
--
-- THE FOUR RULES
--
--   1. A system control account (system_key is not null) may be RENAMED.
--      account_code, account_type, normal_side, parent_id and system_key are
--      refused. notes and active are left alone — neither moves a balance.
--   2. Any account with posted journal lines may not be REPARENTED. Moving it
--      moves every balance beneath it in the trial balance with no entry
--      behind the move.
--   3. Any account with posted journal lines may not have its account_type
--      changed. Same reason, worse: it moves a balance to the other side of
--      the statement.
--   4. An account with no posted lines and no system_key stays fully editable.
--      Nothing has been asserted about it yet.
--
-- Verified before writing this: an account carrying posted journal lines can
-- be reparented on production today, with no refusal of any kind.
--
-- THE ONE WAY THROUGH, AND IT IS THE ONE 0310 ALREADY USES
--
-- public.is_maintenance_session() — app.ledger_maintenance = 'on' AND
-- session_user superuser/bypassrls. Without it this migration would make
-- Shayan's own correction — putting 1000 back at the top level — impossible,
-- which is a guard that refuses the repair as readily as the damage. The
-- allow-list is one entry long, exactly as it is for the period lock.
--
-- AND THE HALF THAT IS NOT ENFORCEMENT
--
-- Asked whether anything would have CAUGHT the wrong parent: no. Nothing did,
-- and nothing would have. `trial_balance_debits_equal_credits` reads the
-- trial_balance view, which groups by account and sums the lines on it —
-- reparenting changes no line, so both totals are identical before and after
-- and the check stays green on a chart of accounts that has been rearranged
-- underneath it. That is §9.6 in its purest form: a check that cannot fail for
-- this defect, sitting next to the defect.
--
-- So the migration adds the check that can: system control accounts are
-- top-level. It is true of 105 of 105 on every company today, and it is
-- exactly the property Shayan's edit broke.

-- ---------------------------------------------------------------------------
-- 1. The refusal.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_chart_of_accounts_edit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The sanctioned repair path, and the only one. Same allow-list as the
  -- period lock (0310): a maintenance session, which is role-gated on
  -- session_user so a SECURITY DEFINER function cannot launder into it.
  if public.is_maintenance_session() then
    return new;
  end if;

  -- RULE 1. A system control account may be renamed. Nothing structural.
  if old.system_key is not null then
    if new.system_key is distinct from old.system_key then
      raise exception 'Account % is a system control account. Its system key cannot be changed.',
        old.account_code using errcode = '23514';
    end if;
    if new.account_code is distinct from old.account_code then
      raise exception 'Account % (%) is a system control account — the name can be changed, the code cannot. Other objects address this account by its code.',
        old.account_code, old.account_name using errcode = '23514';
    end if;
    if new.account_type is distinct from old.account_type then
      raise exception 'Account % (%) is a system control account — its type is fixed at %. Changing it would move every balance under it to a different statement.',
        old.account_code, old.account_name, old.account_type using errcode = '23514';
    end if;
    if new.normal_side is distinct from old.normal_side then
      raise exception 'Account % (%) is a system control account — its normal side is fixed at %.',
        old.account_code, old.account_name, old.normal_side using errcode = '23514';
    end if;
    if new.parent_id is distinct from old.parent_id then
      raise exception 'Account % (%) is a system control account and belongs at the top level. Nesting it under another control account puts its whole subtree into that account''s balance.',
        old.account_code, old.account_name using errcode = '23514';
    end if;
  end if;

  -- RULES 2 AND 3. Posted lines freeze the structure of ANY account. Checked
  -- only when one of the two actually moved, so an ordinary rename does not
  -- pay for a scan of journal_lines.
  if (new.parent_id is distinct from old.parent_id)
     or (new.account_type is distinct from old.account_type) then
    if exists (select 1 from public.journal_lines jl where jl.account_id = old.id) then
      raise exception 'Account % (%) already carries posted journal lines. Its parent and type are fixed: moving it would move a balance with no entry behind the move. Post a correcting entry instead.',
        old.account_code, old.account_name using errcode = '23514';
    end if;
  end if;

  return new;
end
$$;

comment on function public.enforce_chart_of_accounts_edit() is
  'BEFORE UPDATE on chart_of_accounts. A system control account (system_key is not null) may be renamed and nothing else; any account carrying posted journal lines may not be reparented or retyped. A maintenance session bypasses, as it does for the period lock. See 0341 — the dialog only ever discouraged this, and chart_of_accounts has more than one writer.';

drop trigger if exists trg_coa_edit_guard on public.chart_of_accounts;
create trigger trg_coa_edit_guard
  before update on public.chart_of_accounts
  for each row execute function public.enforce_chart_of_accounts_edit();

-- ---------------------------------------------------------------------------
-- 2. The detector, because the refusal is not the whole answer.
-- ---------------------------------------------------------------------------

create or replace function public.misparented_system_accounts(p_company_id uuid)
returns table (account_code text, account_name text, parent_code text, parent_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- tenant guard [claimed, 0242]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select a.account_code, a.account_name, p.account_code, p.account_name
    from public.chart_of_accounts a
    join public.chart_of_accounts p on p.id = a.parent_id
   where a.company_id = p_company_id
     and a.system_key is not null
   order by a.account_code;
end
$$;

comment on function public.misparented_system_accounts(uuid) is
  'System control accounts that have been nested under another account. Must be empty: all 105 keyed accounts are top-level by construction, and an edit that nests one — 1000 Cash in Hand under 1010 Bank Accounts, which happened — moves a whole subtree into another control''s balance while every journal line stays where it was. trial_balance_debits_equal_credits cannot see this: no line moves, so both totals are unchanged. See 0341.';

revoke execute on function public.misparented_system_accounts(uuid) from anon, public;
grant  execute on function public.misparented_system_accounts(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Wire it. The canary's base is READ, not assumed (0304, 0310).
-- ---------------------------------------------------------------------------

do $wire$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int; v_n int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'misparented_system_accounts' then
    raise notice '0341: already wired, nothing to do';
    return;
  end if;

  if strpos(v_src, E'  )\n  select * from real_checks') = 0 then
    raise exception '0341 FAILED: could not find the close of the real_checks CTE — do not guess';
  end if;

  v_new := replace(v_src, E'  )\n  select * from real_checks',
       E'    union all\n'
    || E'    -- 0341. Has a system control account been nested under another?\n'
    || E'    -- No journal line moves when it happens, so the trial balance stays\n'
    || E'    -- green and nothing else in this suite can see it.\n'
    || E'    select ''system_control_accounts_are_top_level''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.misparented_system_accounts(p_company_id)\n'
    || E'  )\n  select * from real_checks');

  v_n := (regexp_match(v_new, 'select (\d+)::numeric n\) e \(n\)'))[1]::int;
  if v_n is null then
    raise exception '0341 FAILED: the canary is not in the single-number shape 0302 left it — do not adjust it blindly';
  end if;
  v_new := regexp_replace(v_new, 'select \d+::numeric n\) e \(n\)',
                          'select ' || (v_n + 1) || '::numeric n) e (n)');

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);
  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$wire$;

-- ---------------------------------------------------------------------------
-- 4. Verification.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_cash uuid; v_bank uuid; v_probe uuid; v_je uuid; v_eq uuid;
      v_n int; v_exp int; v_rows int; v_msg text; v_accepted boolean;
      v_before numeric; v_after numeric;
    begin
      select id into v_co from public.companies where name like 'GUARDS AND GUIDES%';
      if v_co is null then
        select id into v_co from public.companies order by created_at limit 1;
      end if;
      select id into v_cash from public.chart_of_accounts
       where company_id = v_co and account_code = '1000';
      select id into v_bank from public.chart_of_accounts
       where company_id = v_co and account_code = '1010';
      select id into v_eq   from public.chart_of_accounts
       where company_id = v_co and account_code = '3200';
      if v_cash is null or v_bank is null or v_eq is null then
        raise exception '0341: the probe company has no 1000/1010/3200 — cannot self-test';
      end if;

      -- 0. THE STATE OF THE WORLD BEFORE ANYTHING. Every keyed account is
      -- top-level on every company, which is what makes the new check quiet
      -- and able to speak rather than quiet because it is looking at nothing.
      select count(*) into v_n from public.chart_of_accounts
       where system_key is not null and parent_id is not null;
      if v_n <> 0 then
        raise exception '0341: % system control account(s) are already nested — read the list before shipping the check', v_n;
      end if;
      select count(*) into v_n from public.chart_of_accounts where system_key is not null;
      if v_n = 0 then
        raise exception '0341: no account carries a system_key, so rule 1 governs nothing';
      end if;

      -- 1. THE EXACT EDIT THAT HAPPENED IS NOW REFUSED, and the assertion is
      -- on the MESSAGE, not on the fact that something raised.
      v_accepted := false;
      begin
        update public.chart_of_accounts set parent_id = v_bank where id = v_cash;
        v_accepted := true;
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_accepted then
        raise exception '0341 FAILED: 1000 Cash in Hand was nested under 1010 Bank Accounts again';
      end if;
      if v_msg not like '%system control account and belongs at the top level%' then
        raise exception '0341 FAILED: refused, but not by the system-account rule — %', v_msg;
      end if;

      -- 2. AND THE OTHER THREE STRUCTURAL COLUMNS WITH IT.
      v_accepted := false;
      begin
        update public.chart_of_accounts set account_type = 'liability' where id = v_cash;
        v_accepted := true;
      exception when others then null;
      end;
      if v_accepted then
        raise exception '0341 FAILED: a system control account was retyped';
      end if;

      v_accepted := false;
      begin
        update public.chart_of_accounts set account_code = 'ZZ0000' where id = v_cash;
        v_accepted := true;
      exception when others then null;
      end;
      if v_accepted then
        raise exception '0341 FAILED: a system control account was recoded';
      end if;

      -- 3. THE NAME STILL CHANGES. A guard that refuses the permitted edit is
      -- worse than the gap: it is the dialog's warning made unavoidable.
      update public.chart_of_accounts set account_name = 'ZZ 0341 renamed' where id = v_cash;
      if not exists (select 1 from public.chart_of_accounts
                      where id = v_cash and account_name = 'ZZ 0341 renamed') then
        raise exception '0341 FAILED: renaming a system control account no longer works';
      end if;
      update public.chart_of_accounts set account_name = 'Cash in Hand' where id = v_cash;

      -- 4. A FRESH ACCOUNT WITH NO KEY AND NO LINES IS STILL FULLY EDITABLE.
      -- Rule 4, asserted rather than assumed — an over-broad guard would fail
      -- here and nowhere else.
      insert into public.chart_of_accounts
        (company_id, account_code, account_name, account_type, normal_side, system_account)
      values (v_co, 'ZZ0341', 'ZZ 0341 probe', 'asset', 'debit', false)
      returning id into v_probe;

      update public.chart_of_accounts set parent_id = v_bank where id = v_probe;
      update public.chart_of_accounts set account_type = 'expense', normal_side = 'debit'
       where id = v_probe;
      update public.chart_of_accounts set parent_id = null, account_type = 'asset'
       where id = v_probe;

      -- 5. UNTIL IT CARRIES A POSTED LINE. Then parent and type freeze — for an
      -- account with no system_key, so this proves rule 2/3 on their own and
      -- not as a shadow of rule 1. Verified beforehand that this edit SUCCEEDS
      -- on production today.
      insert into public.journal_entries (company_id, entry_date, posting_period, description)
      values (v_co, current_date, date_trunc('month', current_date)::date, 'ZZ 0341 probe entry')
      returning id into v_je;
      insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
      values (v_je, v_probe, 100, 0), (v_je, v_eq, 0, 100);

      v_accepted := false;
      begin
        update public.chart_of_accounts set parent_id = v_bank where id = v_probe;
        v_accepted := true;
      exception when others then
        v_msg := sqlerrm;
      end;
      if v_accepted then
        raise exception '0341 FAILED: an account carrying posted journal lines was reparented';
      end if;
      if v_msg not like '%already carries posted journal lines%' then
        raise exception '0341 FAILED: refused, but not by the posted-lines rule — %', v_msg;
      end if;

      v_accepted := false;
      begin
        update public.chart_of_accounts set account_type = 'expense' where id = v_probe;
        v_accepted := true;
      exception when others then null;
      end;
      if v_accepted then
        raise exception '0341 FAILED: an account carrying posted journal lines was retyped';
      end if;

      -- And its NAME still changes, because renaming moves nothing.
      update public.chart_of_accounts set account_name = 'ZZ 0341 probe renamed'
       where id = v_probe;

      -- 6. THE MAINTENANCE SESSION IS THE WAY BACK. Without it the guard
      -- refuses the repair as readily as the damage.
      --
      -- The trial balance is read BEFORE the edit, not after. Reading it after
      -- and calling it "before" would be a comparison of a figure with itself,
      -- which is exactly the shape of check this file is written against.
      select actual into v_before from public.ledger_checks(v_co)
       where check_name = 'trial_balance_debits_equal_credits';

      perform set_config('app.ledger_maintenance', 'on', true);
      if not public.is_maintenance_session() then
        raise exception '0341 FAILED: this session cannot become a maintenance session, so the bypass is untestable here';
      end if;
      update public.chart_of_accounts set parent_id = v_bank where id = v_cash;
      perform set_config('app.ledger_maintenance', 'off', true);

      -- 7. AND THE NEW CHECK SEES IT — which is the point.
      select count(*) into v_n from public.misparented_system_accounts(v_co);
      if v_n <> 1 then
        raise exception '0341 FAILED: the detector reports % nested control account(s), expected 1', v_n;
      end if;
      if not exists (select 1 from public.ledger_checks(v_co)
                      where check_name = 'system_control_accounts_are_top_level' and not passed) then
        raise exception '0341 FAILED: a nested control account did not turn the check red';
      end if;

      -- The point of the check, stated as an assertion: the trial balance is
      -- unmoved by the very edit that just went wrong.
      select actual into v_after from public.ledger_checks(v_co)
       where check_name = 'trial_balance_debits_equal_credits';
      if v_after is distinct from v_before then
        raise exception '0341: the trial balance DID move on a reparent (% -> %) — the header says it cannot; re-read it', v_before, v_after;
      end if;

      -- Put it back the way it was, inside the maintenance session.
      perform set_config('app.ledger_maintenance', 'on', true);
      update public.chart_of_accounts set parent_id = null where id = v_cash;
      perform set_config('app.ledger_maintenance', 'off', true);

      if exists (select 1 from public.misparented_system_accounts(v_co)) then
        raise exception '0341 FAILED: the probe did not restore 1000 to the top level';
      end if;

      -- 8. THE SUITE GREW BY ONE, THE CANARY PASSES ON EVERY COMPANY, AND THE
      -- TENANT GUARDS ARE INTACT.
      select count(*) into v_rows from public.ledger_checks(v_co);
      select l.expected::int into v_exp from public.ledger_checks(v_co) l
       where l.check_name = 'checks_evaluated';
      if v_rows <> v_exp + 1 then
        raise exception '0341 FAILED: ledger_checks returned % rows for an expected check count of %', v_rows, v_exp;
      end if;
      select count(*) into v_n
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_n <> 0 then
        raise exception '0341 FAILED: the canary is red on % compan(ies)', v_n;
      end if;
      select count(*) into v_n from public.tenant_guard_gaps();
      if v_n <> 0 then
        raise exception '0341 FAILED: tenant_guard_gaps() reports % gap(s)', v_n;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0341 verification failed: %', v_outcome;
  end if;
end
$verify$;
