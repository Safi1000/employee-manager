-- 0296 — the two alert-raising controls become WARNINGS, and one of them gets
-- wired to something that runs. The other does not, and the reason is data.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE DECISION, RECORDED AS A DECISION
--
-- Shayan was asked explicitly whether the armed-post rule should BLOCK or
-- WARN, and chose WARN. Both controls were written raising tier 'blocking';
-- both now raise 'warning'. This was chosen, not inherited, and it is written
-- here so that a reader who finds a warning where they expected a block does
-- not "fix" it back.
--
-- There is no escalation. A warning that nobody actions stays a warning.
--
-- WHAT A WARNING MEANS AT THE CALL SITE
--
-- The functions still compute and return the honest answer —
-- check_disbursement still returns 'blocked' when policy says the payment
-- should not go out. The RETURN VALUE is what the policy says; the CALLER
-- decides enforcement. Today's caller records and proceeds. That separation is
-- deliberate: if the decision is ever revisited, the enforcement changes at the
-- call site and the policy function does not have to be rewritten.
--
-- The alert TEXT changed to match. An alert reading "Disbursement blocked"
-- when the disbursement was not blocked is a false statement in a feed whose
-- whole value is that a person can trust what it says. Rewording it is not
-- softening the decision; it is refusing to write a message that is untrue.
--
-- ── WIRED: check_disbursement ────────────────────────────────────────────
--
-- An expense is the non-payroll cash outflow in this schema. There is no
-- expense-payment RPC — the application inserts into public.expenses with a
-- payment_mode, and payables are settled by setting paid_at — so the trigger
-- covers both moments.
--
-- It fires only when danger_level.band is 'red'. That band is currently
-- 'amber', and danger_level is a VIEW computed from cash, so the control is
-- quiet today and becomes loud exactly when the condition it describes is
-- true. That is what a control should look like.
--
-- ONE LIMITATION, STATED RATHER THAN DISCOVERED: p_is_payroll_or_statutory is
-- passed FALSE for every expense. Payroll does not flow through this table, so
-- that half is right. Statutory payments made AS EXPENSES would be warned
-- about when the policy exempts them — and there is no marker on expenses or
-- expense_categories that identifies one. When such a marker exists, pass it.
-- The cost today is a warning that should not have fired, which 0295's dedupe
-- collapses to a single row.
--
-- ── NOT WIRED: check_deploy_guard, and why ───────────────────────────────
--
-- It was measured before wiring, and the measurement stopped it.
--
--   active employees                       758
--   not weapons-certified                  758   <- every one
--   no weapon licence document on file     758   <- every one
--   police verification pending            701
--   NADRA Verisys pending                  701
--   police or NADRA ADVERSE                  0
--   blacklisted                              0
--
-- armed_post_blockers() returns a non-empty list for EVERY employee in the
-- database. Wiring it to the deployment path raises a warning on every
-- deployment, 100% of the time, forever.
--
-- A control that fires on every input carries exactly as much information as
-- one that never fires. This is the finding from the compliance consolidation
-- in mirror image: there, five implementations agreed because all their inputs
-- were empty; here, one control alarms constantly because its inputs are
-- empty. Both produce an output that does not depend on the world. And the
-- practical harm is worse in this direction — the alerts feed has never held a
-- row, and its first day would be hundreds of identical warnings, which is how
-- a reader learns to ignore it. That is the failure this whole stream has been
-- about.
--
-- The root cause is the same as the licence columns: the vetting fields are
-- unpopulated. weapons_certified is false for all 758 because nobody has
-- entered it, not because 758 guards failed a test.
--
-- SECOND, INDEPENDENT REASON: there is no such thing as an armed post in this
-- schema. The rule is "must not be deployed to a SENSITIVE OR ARMED post", and
-- public.posts has no column that marks one. Firing on every deployment does
-- not approximate the rule; it replaces it with a different rule that nobody
-- agreed to.
--
-- So this migration does not wire it. What to do is a policy question:
--
--   1. Distinguish a vetting FAILURE from a vetting GAP. blacklisted, police
--      adverse, NADRA adverse and not-in-active-service are failures and are
--      true of nobody today — a control on those alone would be quiet and able
--      to speak. "Not certified" and "document not on file" are gaps in data
--      entry. That split is a change to what the rule means, so it is Shayan's
--      and Safi's to make, not mine.
--   2. Give posts a way to say "armed" or "sensitive", so the rule can be
--      applied where it was written to apply.
--
-- Until one of those, wiring it would move the silence rather than end it.
-- Its tier is corrected to 'warning' here so that the decision is recorded
-- against the function, and it stays in uninvoked_controls() where it belongs.

-- ---------------------------------------------------------------------------
-- The two controls: warning, and messages that describe what actually happens.
-- Guard calls carried over verbatim.
-- ---------------------------------------------------------------------------

create or replace function public.check_deploy_guard(p_employee_id uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_block text[];
begin
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0242)
  if p_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;

  v_block := public.armed_post_blockers(p_employee_id);
  if array_length(v_block, 1) > 0 then
    -- 0296. WARNING, chosen explicitly. Nothing here prevents the deployment,
    -- and the wording says so rather than claiming a block that did not occur.
    perform public.raise_alert(
      (select company_id from public.employees where id = p_employee_id),
      'warning', 'deploy_unverified_guard',
      'Guard is not cleared for a sensitive/armed post: ' || array_to_string(v_block, ', '),
      'employees', p_employee_id,
      (select branch_id from public.employees where id = p_employee_id));
  end if;
  return v_block;
end;
$function$;

comment on function public.check_deploy_guard(uuid) is
  'Returns the reasons a guard is not cleared for a sensitive/armed post, and records a WARNING alert when the list is non-empty. Warning rather than blocking was chosen explicitly (0296), not inherited. NOT wired to the deployment path: armed_post_blockers() is non-empty for all 758 active employees because the vetting fields are unpopulated, so it would fire on every deployment and carry no information, and public.posts has no way to mark a post armed. See 0296.';

create or replace function public.check_disbursement(
  p_company_id uuid,
  p_amount numeric,
  p_is_payroll_or_statutory boolean default false)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_band text;
begin
  -- tenant guard [claimed]: p_company_id IS the caller's claim; compared as given (0242)
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select band into v_band from public.danger_level where company_id = p_company_id;

  -- Payroll and statutory always flow, even in Red (they are the floor itself).
  if coalesce(p_is_payroll_or_statutory, false) then
    return 'allowed';
  end if;

  if v_band = 'red' then
    -- 0296. WARNING, chosen explicitly. The RETURN still says 'blocked' —
    -- that is what policy says — but no caller enforces it today, so the
    -- message must not claim the payment was stopped.
    perform public.raise_alert(p_company_id, 'warning', 'danger_level_disbursement',
      'Disbursement of ' || p_amount || ' went out while cash is in the RED danger band. '
      || 'Policy requires a COO override; this is recorded, not enforced.',
      null, null, null);
    return 'blocked';
  end if;
  return 'allowed';
end;
$function$;

comment on function public.check_disbursement(uuid, numeric, boolean) is
  'Policy answer for a non-payroll disbursement against the cash danger band. Returns allowed/blocked — the RETURN is what policy says, the CALLER decides enforcement. Records a WARNING alert in the red band; warning rather than blocking was chosen explicitly (0296). Wired to public.expenses by trg_xxx_expenses_disbursement_warning.';

-- ---------------------------------------------------------------------------
-- The wiring. AFTER, so a warning can never affect whether the money moved.
-- ---------------------------------------------------------------------------

create or replace function public.warn_on_disbursement()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Only when money actually leaves: an expense inserted already paid, or a
  -- payable settled by paid_at moving from null to set. An UPDATE that edits a
  -- description on an already-paid expense must not re-warn.
  if tg_op = 'INSERT' then
    if new.paid_at is null and new.payment_mode is null then
      return null;
    end if;
  else
    if not (old.paid_at is null and new.paid_at is not null) then
      return null;
    end if;
  end if;

  -- Return value deliberately discarded. This is a WARNING (0296): the alert
  -- is the whole effect, and an AFTER trigger cannot stop the write anyway.
  perform public.check_disbursement(new.company_id, new.amount, false);
  return null;
end;
$function$;

comment on function public.warn_on_disbursement() is
  'AFTER trigger on public.expenses. Calls check_disbursement so the red-band rule is recorded when a non-payroll payment goes out. Discards the return: warning, not blocking (0296). Fires on an expense inserted already paid, and on a payable whose paid_at moves from null to set.';

drop trigger if exists trg_xxx_expenses_disbursement_warning on public.expenses;
create trigger trg_xxx_expenses_disbursement_warning
  after insert or update of paid_at on public.expenses
  for each row execute function public.warn_on_disbursement();

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_cat uuid; v_exp uuid; v_cnt int; v_tier text; v_msg text;
      v_def text; v_before int; v_bank uuid;
    begin
      select id into v_co from public.companies order by created_at limit 1;
      select id into v_cat from public.expense_categories where company_id = v_co limit 1;
      -- Bank, not Cash: expenses_cash_names_a_location requires a custodian
      -- location for a cash expense, and a fixture that trips an unrelated
      -- constraint would fail this migration for a reason that has nothing to
      -- do with the control it is testing.
      select id into v_bank from public.bank_accounts limit 1;

      -- 1. THE TIER IS WARNING, NOT BLOCKING — asserted on a raised row, not
      -- on the source text. A control whose tier was checked by grep would
      -- pass with the word 'warning' sitting in a comment.
      --
      -- danger_level is a VIEW computed from cash, so red cannot be inserted.
      -- Stub it to red, exercise the path, restore. Same idiom as 0289.
      v_def := pg_get_viewdef('public.danger_level'::regclass, true);

      execute 'create or replace view public.danger_level as
               select c.id as company_id, 0::numeric as available_cash,
                      0::numeric as min_cash, 0::numeric as ratio,
                      ''red''::text as band
                 from public.companies c';

      perform public.check_disbursement(v_co, 12345, false);

      select count(*), max(tier::text), max(message)
        into v_cnt, v_tier, v_msg
        from public.alerts where category = 'danger_level_disbursement';
      if v_cnt <> 1 then
        raise exception '0296 FAILED: red-band disbursement raised % alert(s), expected 1', v_cnt;
      end if;
      if v_tier <> 'warning' then
        raise exception '0296 FAILED: tier is %, expected warning — the decision was explicit', v_tier;
      end if;
      if v_msg like '%blocked%' then
        raise exception '0296 FAILED: the message claims the disbursement was blocked, and it was not';
      end if;

      -- 2. THE TRIGGER ACTUALLY RUNS, and does not block the write. This is
      -- the whole point of the migration: the control was correct and
      -- uninvoked, so the assertion is that something now invokes it.
      delete from public.alerts where category = 'danger_level_disbursement';

      insert into public.expenses (company_id, category_id, description, amount,
                                   expense_date, payment_mode, bank_account_id)
      values (v_co, v_cat, 'ZZ 0296 probe', 999, current_date, 'Bank', v_bank)
      returning id into v_exp;

      if v_exp is null then
        raise exception '0296 FAILED: the warning trigger blocked the expense insert';
      end if;

      select count(*) into v_cnt from public.alerts
       where category = 'danger_level_disbursement';
      if v_cnt <> 1 then
        raise exception '0296 FAILED: an expense paid in the red band raised % alert(s), expected 1', v_cnt;
      end if;

      -- 3. IT IS QUIET WHEN THE CONDITION IS FALSE. A control that fires
      -- regardless of the world is the defect this migration declined to ship
      -- for check_deploy_guard; it must not be shipped here either.
      execute 'create or replace view public.danger_level as
               select c.id as company_id, 0::numeric as available_cash,
                      0::numeric as min_cash, 0::numeric as ratio,
                      ''amber''::text as band
                 from public.companies c';
      delete from public.alerts where category = 'danger_level_disbursement';

      insert into public.expenses (company_id, category_id, description, amount,
                                   expense_date, payment_mode, bank_account_id)
      values (v_co, v_cat, 'ZZ 0296 probe amber', 999, current_date, 'Bank', v_bank);

      select count(*) into v_cnt from public.alerts
       where category = 'danger_level_disbursement';
      if v_cnt <> 0 then
        raise exception '0296 FAILED: the amber band still raised % alert(s)', v_cnt;
      end if;

      execute 'create or replace view public.danger_level as ' || v_def;

      -- 4. check_disbursement IS NO LONGER UNINVOKED, and check_deploy_guard
      -- STILL IS. The second half matters as much as the first: this migration
      -- deliberately left one unwired, and the audit must keep saying so
      -- rather than quietly losing it.
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'check_disbursement') then
        raise exception '0296 FAILED: check_disbursement is still reported as uninvoked';
      end if;
      if not exists (select 1 from public.uninvoked_controls()
                      where object_name = 'check_deploy_guard') then
        raise exception '0296 FAILED: check_deploy_guard was wired, and this migration says it was not';
      end if;

      -- 5. THE TENANT GUARDS SURVIVED. Both functions were retyped in full.
      select count(*) into v_cnt from public.tenant_guard_gaps();
      if v_cnt <> 0 then
        raise exception '0296 FAILED: tenant_guard_gaps() reports % gap(s) after rewriting the two controls', v_cnt;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0296 verification failed: %', v_outcome;
  end if;
end
$verify$;
