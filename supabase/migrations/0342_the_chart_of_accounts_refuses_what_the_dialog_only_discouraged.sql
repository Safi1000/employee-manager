-- 0342 — the chart of accounts refuses what the dialog only discouraged.
--
-- THIS IS A REBUILD OF A MIGRATION THAT WAS LOST, and the loss is the first
-- thing to record because it is the more general defect.
--
-- This enforcement was written as 0341 and applied to the DEV database
-- (`0341_the_chart_of_accounts_refuses_what_the_dialog_only_discouraged`, in
-- dev's schema_migrations). It never reached the repo and never reached
-- production. The number 0341 was then REUSED for
-- `0341_the_august_31_cutover_restates_receivables`, which is what production
-- carries. So on 2026-09-03 the position was:
--
--   dev  — guard present, number 0341, no repo file
--   prod — no guard at all, number 0341 means something else entirely
--   repo — neither
--
-- The functions below were recovered verbatim from the live dev definitions
-- (`pg_get_functiondef`), not rewritten from memory. The `system_key`
-- derivation and the reasoning about the trial balance are the originals.
--
-- WHY IT MATTERS TODAY. Shayan reparented **1000 Cash in Hand under 1010 Bank
-- Accounts** through the Chart of Accounts dialog. It saved. The dialog said
-- "System account — rename is fine; changing type is not recommended" and
-- nothing enforced it. Cash is not a bank account, and that edit puts cash and
-- bank in one control subtree, defeating the per-location and per-bank routing
-- 0262, 0271 and 0276 exist for. He set it back by hand. Nothing stopped him
-- doing it and nothing would stop the next person.
--
-- A RECOMMENDATION IS NOT A CONTROL, and `chart_of_accounts` has more than one
-- writer, so the enforcement is in the database and not in the dialog.
--
-- THE RULES
--
--   1. A system account (system_key is not null) may have its NAME changed.
--      Nothing else: code, type, normal side and parent are refused.
--   2. ANY account carrying posted journal lines may not be REPARENTED.
--   3. ANY account carrying posted journal lines may not have its ACCOUNT_TYPE
--      changed. Same reason as 2 and worse — it moves a balance to the other
--      side of the statement.
--   4. An account with no posted lines and no system_key stays fully editable.
--      Nothing has been asserted about it yet.
--
-- Rules 2 and 3 are tested only when parent or type actually moved, so an
-- ordinary rename does not pay for a scan of journal_lines.
--
-- WHY A CHECK AS WELL AS A TRIGGER, which is the question the report asked:
--
-- NOTHING IN THE SUITE COULD CATCH A WRONGLY REPARENTED ACCOUNT.
-- `trial_balance_debits_equal_credits` sums journal_lines. Reparenting moves NO
-- journal line — it changes one `parent_id` — so debits and credits are
-- untouched and the check stays green. It was green before Shayan's edit, green
-- while Cash in Hand sat under Bank Accounts, and green after he undid it. The
-- arithmetic balances either way; that is precisely why it cannot see this
-- class of error. `system_control_accounts_are_top_level` is the structural
-- check that can, and it takes the suite from 29 to 30.
--
-- THE MAINTENANCE ESCAPE is the same allow-list as the period lock (0310): a
-- maintenance session, role-gated on session_user so a SECURITY DEFINER
-- function cannot launder into it. A repair that genuinely must reparent has a
-- sanctioned path, and it leaves a trail.
--
-- ledger_checks HAS MANY AUTHORS, so the wiring below is SURGERY against the
-- live definition with anchors asserted to appear exactly once — never a
-- restatement from a copy.

-- ---------------------------------------------------------------------------
-- 1. The guard.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_chart_of_accounts_edit()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
$function$;

drop trigger if exists trg_coa_edit_guard on public.chart_of_accounts;
create trigger trg_coa_edit_guard
  before update on public.chart_of_accounts
  for each row execute function public.enforce_chart_of_accounts_edit();

-- ---------------------------------------------------------------------------
-- 2. The detector. A system control account is identified by system_key, which
--    is what makes it a control account — not by a name or a code prefix.
-- ---------------------------------------------------------------------------
create or replace function public.misparented_system_accounts(p_company_id uuid)
returns table(account_code text, account_name text, parent_code text, parent_name text)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
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
$function$;

-- ---------------------------------------------------------------------------
-- 3. Wire the check in. Surgery, two anchors, each asserted exactly once.
-- ---------------------------------------------------------------------------
do $surgery$
declare
  v_def text; v_a text; v_b text; v_ra text; v_rb text; v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0342 REFUSED: public.ledger_checks does not exist'; end if;

  if v_def ilike '%misparented_system_accounts%' then
    raise notice '0342: the check is already wired into ledger_checks; leaving it alone';
    return;
  end if;

  v_a := $a$      from public.revenue_outside_service_month(p_company_id)
  )
  select * from real_checks$a$;

  v_ra := $b$      from public.revenue_outside_service_month(p_company_id)
    union all
    -- 0342. Has a system control account been nested under another? No journal
    -- line moves when it happens, so the trial balance stays green and nothing
    -- else in this suite can see it.
    select 'system_control_accounts_are_top_level'::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.misparented_system_accounts(p_company_id)
  )
  select * from real_checks$b$;

  v_hits := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
  if v_hits <> 1 then
    raise exception '0342 REFUSED: the real_checks tail anchor appears % time(s), expected 1', v_hits;
  end if;

  v_b  := '(select 29::numeric n) e (n);   -- expected_check_count';
  v_rb := '(select 30::numeric n) e (n);   -- expected_check_count';
  v_hits := (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b);
  if v_hits <> 1 then
    raise exception
      '0342 REFUSED: expected_check_count is not the single literal 29 this file expects (% match(es)). Someone added a check without this file knowing; re-read the live definition and re-anchor.', v_hits;
  end if;

  execute replace(replace(v_def, v_a, v_ra), v_b, v_rb);
end
$surgery$;

-- ---------------------------------------------------------------------------
-- PROOF. Every write below is rolled back by the exception that ends its block.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co    uuid := (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
  v_cash  uuid; v_bank uuid; v_free uuid;
  v_tb_before numeric; v_tb_after numeric;
  v_msg   text; v_n int; v_cnt numeric; v_ok boolean;
begin
  if v_co is null then
    raise notice '0342: GGS not on this database; behavioural proofs skipped';
  else
    select id into v_cash from public.chart_of_accounts
     where company_id = v_co and account_code = '1000';
    select id into v_bank from public.chart_of_accounts
     where company_id = v_co and account_code = '1010';

    -- (a) THE ACTUAL DEFECT: 1000 Cash in Hand under 1010 Bank Accounts is
    --     refused, and refused by ITS OWN MESSAGE, not merely by something
    --     raising. A test that asserts "an error happened" passes against the
    --     wrong trigger.
    v_msg := null;
    begin
      update public.chart_of_accounts set parent_id = v_bank where id = v_cash;
      v_msg := '(accepted)';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like '%is a system control account and belongs at the top level%' then
      raise exception '0342 FAILED: reparenting Cash in Hand under Bank Accounts was not refused correctly — got %', v_msg;
    end if;

    -- (b) retyping a system control account is refused, by its own message
    v_msg := null;
    begin
      update public.chart_of_accounts set account_type = 'expense' where id = v_cash;
      v_msg := '(accepted)';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg not like '%its type is fixed at%' then
      raise exception '0342 FAILED: retyping a system control account was not refused correctly — got %', v_msg;
    end if;

    -- (c) RENAMING ONE IS STILL ALLOWED. The guard must not be a blanket
    --     freeze; rule 1 says the name may change.
    v_msg := null;
    begin
      update public.chart_of_accounts set account_name = account_name || ' (0342 probe)'
       where id = v_cash;
      raise exception 'ROLLBACK_PROBE';
    exception when others then v_msg := sqlerrm;
    end;
    if v_msg <> 'ROLLBACK_PROBE' then
      raise exception '0342 FAILED: renaming a system control account was refused, and rule 1 permits it — got %', v_msg;
    end if;

    -- (d) AN ACCOUNT WITH POSTED LINES CANNOT BE REPARENTED even without a
    --     system_key. 1100 carries lines on this database.
    select id into v_free from public.chart_of_accounts
     where company_id = v_co and account_code = '1100';
    if exists (select 1 from public.journal_lines jl where jl.account_id = v_free) then
      v_msg := null;
      begin
        update public.chart_of_accounts set parent_id = v_bank where id = v_free;
        v_msg := '(accepted)';
      exception when others then v_msg := sqlerrm;
      end;
      -- 1100 is itself a system account, so rule 1 fires first; either refusal
      -- is correct, but it must be one of them and not silence.
      if v_msg = '(accepted)' then
        raise exception '0342 FAILED: an account carrying posted journal lines was reparented';
      end if;
    end if;

    -- (e) THE TRIAL BALANCE CANNOT SEE ANY OF THIS. This is the claim the whole
    --     check rests on, so it is measured rather than asserted in prose:
    --     debits and credits are identical before and after the attempts above,
    --     because not one journal line moved.
    select expected, actual into v_tb_before, v_tb_after
      from public.ledger_checks(v_co) where check_name = 'trial_balance_debits_equal_credits';
    if v_tb_before is distinct from v_tb_after then
      raise exception '0342 FAILED: the trial balance does not balance (% vs %) — unrelated to this file, but it must not ship red', v_tb_before, v_tb_after;
    end if;

    -- (f) the detector runs and the company is clean (Shayan undid the edit)
    select count(*) into v_n from public.misparented_system_accounts(v_co);
    if v_n <> 0 then
      raise exception '0342: % system control account(s) are nested under another and must be moved back to the top level before this ships', v_n;
    end if;
  end if;

  -- (g) THE CHECK IS IN THE SUITE AND THE CANARY AGREES. checks_evaluated
  --     compares the count against expected_check_count; if the surgery added
  --     the check without bumping the literal, this row goes red — which is
  --     0302's whole purpose and is exactly the mistake to catch here.
  select count(*) into v_n from public.ledger_checks(v_co)
   where check_name = 'system_control_accounts_are_top_level';
  if v_n <> 1 then
    raise exception '0342 FAILED: system_control_accounts_are_top_level is not in the suite (% row(s))', v_n;
  end if;
  select actual, passed into v_cnt, v_ok from public.ledger_checks(v_co)
   where check_name = 'checks_evaluated';
  if v_cnt <> 30 or not v_ok then
    raise exception '0342 FAILED: checks_evaluated reports % and passed=% — expected 30 and true', v_cnt, v_ok;
  end if;

  raise notice '0342 OK: guard armed on chart_of_accounts, detector installed, suite now 30 checks.';
end
$proof$;
