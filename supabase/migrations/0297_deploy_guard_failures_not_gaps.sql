-- 0297 — a vetting FAILURE is not a vetting GAP. Split them, and wire the
-- deploy guard to the half that can distinguish one guard from another.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHAT 0296 REFUSED TO DO AND WHY THIS IS DIFFERENT
--
-- 0296 declined to wire check_deploy_guard. armed_post_blockers() returns a
-- non-empty list for all 758 active employees, so wiring it to the deployment
-- path would raise a warning on every deployment, 100% of the time, forever —
-- a control whose output does not depend on the world, in a feed that has
-- never held a row and would have learned to be ignored on its first day.
--
-- The fix is not to suppress it. It is that two different questions were
-- wearing one name:
--
--   FAILURE   blacklisted, police verification adverse, NADRA Verisys adverse,
--             not in active service.
--             Someone looked, and the answer was bad.
--             TRUE OF NOBODY TODAY — so a control on these is quiet AND ABLE
--             TO SPEAK, which is what a working check looks like.
--
--   GAP       not weapons-certified, weapon licence not on file, discharge
--             certificate missing, verification still 'pending'.
--             Nobody looked yet.
--             TRUE OF EVERYBODY — 758 of 758 on both counts. That is a
--             coverage number, not an event. It goes in a report.
--
-- A condition true of every row is a measurement. Routed to a report, it is
-- one line Shayan reads once. Routed to an alert, it is 758 warnings that
-- teach him the feed is not worth opening.
--
-- WHAT MOVES AND WHAT DOES NOT
--
-- armed_post_blockers() is UNCHANGED. It returns the full list, failures and
-- gaps together, and that is correct for its one existing caller:
-- src/app/components/EmployeeVettingFields.tsx renders it to a person who is
-- looking at that guard's record, where "weapon licence not on file" is
-- exactly what they need to see. A screen showing one guard wants everything;
-- a feed watching 758 wants only what separates them.
--
-- check_deploy_guard() also still RETURNS the full list — its return contract
-- is unchanged, so nothing that reads it breaks. Only the alerting condition
-- narrows.
--
-- THE EXPIRY CASES ARE FAILURES, NOT GAPS
--
-- 'weapons certification expired' and 'weapon licence expired' sit in the
-- failure set deliberately. Something was recorded and has since lapsed, which
-- is a fact about the guard rather than about the data entry. Neither is true
-- of anybody today, so neither makes the control noisy — but if one becomes
-- true it is exactly the thing worth saying.
--
-- 'pending' verification is a GAP: it means the check has been started and not
-- returned. 'adverse' is a FAILURE: it came back and it was bad. 701 employees
-- are pending and 0 are adverse, which is the whole argument in two numbers.
--
-- NOT DONE HERE, AND DELIBERATELY
--
-- There is still no such thing as an armed post in this schema. This wiring
-- fires on EVERY deployment where the guard has a vetting failure, not only on
-- sensitive or armed ones, because public.posts has no column that marks one.
-- That is a broader rule than the one written, and it is broader in the safe
-- direction: a guard who is blacklisted or has adverse verification should not
-- be posted anywhere, so alerting on all posts over-covers rather than
-- under-covers. The narrower rule needs an operational decision about what an
-- armed post is and who marks it, which is proposed separately and not built.

-- ---------------------------------------------------------------------------
-- The failure half, as its own function so the split has one definition and
-- the two lists cannot drift apart in someone's head.
-- ---------------------------------------------------------------------------

create or replace function public.armed_post_failures(p_employee_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0242)
  if p_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;

  return (
    select array_remove(array[
      -- Someone looked, and the answer was bad.
      case when e.blacklisted then 'blacklisted' end,
      case when e.police_verification_status = 'adverse' then 'police verification adverse' end,
      case when e.nadra_verisys_status = 'adverse' then 'NADRA Verisys adverse' end,
      case when e.lifecycle_state <> 'active' then 'not in active service' end,
      -- Recorded, then lapsed. A fact about the guard, not about data entry.
      case when e.weapons_certified and e.weapons_cert_expiry is not null
                and e.weapons_cert_expiry < current_date then 'weapons certification expired' end,
      case when exists (select 1 from public.guard_documents gd
                        where gd.employee_id = e.id
                          and gd.doc_type = 'weapon_licence' and gd.status = 'expired')
           then 'weapon licence expired' end
    ], null)
    from public.employees e where e.id = p_employee_id);
end;
$function$;

comment on function public.armed_post_failures(uuid) is
  'The subset of armed_post_blockers() that is a vetting FAILURE rather than a vetting GAP: someone looked and the answer was bad, or something was recorded and has lapsed. True of nobody today, which is what lets a control built on it stay quiet and still be able to speak. armed_post_blockers() keeps the full list for the screen that shows one guard. See 0297 and TENANT_GUARD_REPORT.md 9.11.';

revoke execute on function public.armed_post_failures(uuid) from anon, public;
grant  execute on function public.armed_post_failures(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- check_deploy_guard: same return, narrower alarm.
-- ---------------------------------------------------------------------------

create or replace function public.check_deploy_guard(p_employee_id uuid)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_block text[];
  v_fail  text[];
begin
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0242)
  if p_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_employee_id)); end if;

  v_block := public.armed_post_blockers(p_employee_id);
  v_fail  := public.armed_post_failures(p_employee_id);

  -- 0297. Alert on FAILURES only. The gaps — 758 of 758 not weapons-certified,
  -- 758 with no licence on file — are a coverage number and are reported, not
  -- alerted. See the header.
  --
  -- 0296. WARNING, chosen explicitly. Nothing here prevents the deployment,
  -- and the wording says so rather than claiming a block that did not occur.
  if array_length(v_fail, 1) > 0 then
    perform public.raise_alert(
      (select company_id from public.employees where id = p_employee_id),
      'warning', 'deploy_unverified_guard',
      'Guard deployed with a vetting failure: ' || array_to_string(v_fail, ', '),
      'employees', p_employee_id,
      (select branch_id from public.employees where id = p_employee_id));
  end if;

  -- Return contract unchanged: the FULL list, so any caller that shows a
  -- person why a guard is not cleared keeps seeing the gaps too.
  return v_block;
end;
$function$;

comment on function public.check_deploy_guard(uuid) is
  'Returns the full list of reasons a guard is not cleared for a sensitive/armed post, and records a WARNING alert when any of them is a vetting FAILURE rather than a gap (0297). Warning rather than blocking was chosen explicitly (0296). Wired to public.deployments by trg_xxx_deployments_vetting_warning. Fires on every post, not only armed ones: public.posts has no way to mark one, and over-covering is the safe direction for blacklisted or adverse-verification guards.';

-- ---------------------------------------------------------------------------
-- The wiring. AFTER, so a warning can never affect whether the guard was posted.
-- ---------------------------------------------------------------------------

create or replace function public.warn_on_deployment_vetting()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Return value deliberately discarded. This is a WARNING (0296): the alert
  -- is the whole effect, and an AFTER trigger cannot stop the write anyway.
  perform public.check_deploy_guard(new.guard_id);
  return null;
end;
$function$;

comment on function public.warn_on_deployment_vetting() is
  'AFTER trigger on public.deployments. Calls check_deploy_guard so a guard posted with a vetting failure is recorded. Discards the return: warning, not blocking (0296/0297).';

drop trigger if exists trg_xxx_deployments_vetting_warning on public.deployments;
create trigger trg_xxx_deployments_vetting_warning
  after insert on public.deployments
  for each row execute function public.warn_on_deployment_vetting();

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_emp uuid; v_emp2 uuid; v_cli uuid; v_dep uuid;
      v_cnt int; v_noisy int; v_tier text; v_msg text;
      v_block text[]; v_full int;
    begin
      select id into v_co from public.companies order by created_at limit 1;
      select e.id into v_emp from public.employees e
       where e.company_id = v_co and e.lifecycle_state = 'active' limit 1;
      -- A SECOND employee for the failure case. deployments carries a unique
      -- constraint deployments_one_active_per_guard, so the clean probe and the
      -- failing probe cannot be the same person — an earlier version of this
      -- block reused one and failed on my fixture rather than on the control.
      select e.id into v_emp2 from public.employees e
       where e.company_id = v_co and e.lifecycle_state = 'active' and e.id <> v_emp
       limit 1;
      select c.id into v_cli from public.clients c where c.company_id = v_co limit 1;
      if v_emp is null or v_emp2 is null or v_cli is null then
        raise exception '0297: need two active employees and a client to probe';
      end if;

      -- 1. THE CONTROL IS QUIET. This is the entire reason for the split, so
      -- it is asserted over the WHOLE population rather than on one row: no
      -- active employee anywhere may currently have a vetting failure. If this
      -- ever fails, the wiring is about to become noisy and somebody should
      -- know before it does, not after.
      select count(*) into v_noisy from public.employees e
       where e.lifecycle_state in ('active', 'on_leave')
         and array_length(public.armed_post_failures(e.id), 1) > 0;
      if v_noisy <> 0 then
        raise exception '0297 FAILED: % employee(s) already carry a vetting failure — the control would fire on them immediately; review before shipping', v_noisy;
      end if;

      -- 2. AND THE GAPS ARE STILL THERE. Proving quiet is worthless if the
      -- split simply dropped everything: armed_post_blockers must still be
      -- non-empty for this employee, or the "failure" set is quiet because the
      -- source is empty rather than because the split worked.
      v_block := public.armed_post_blockers(v_emp);
      if coalesce(array_length(v_block, 1), 0) = 0 then
        raise exception '0297 FAILED: armed_post_blockers is empty for the probe employee — quiet here would prove nothing';
      end if;

      -- 3. A CLEAN DEPLOYMENT RAISES NOTHING. The gaps must not alert.
      --
      -- end_date is supplied: deployments_one_active_per_guard is unique on
      -- guard_id WHERE end_date IS NULL, and both probe employees are already
      -- posted. Without it this block fails on my fixture rather than on the
      -- control, which it did twice before I read the index definition.
      insert into public.deployments (company_id, guard_id, client_id, start_date, end_date)
      values (v_co, v_emp, v_cli, current_date, current_date + 30) returning id into v_dep;

      select count(*) into v_cnt from public.alerts
       where category = 'deploy_unverified_guard';
      if v_cnt <> 0 then
        raise exception '0297 FAILED: deploying a guard with only GAPS raised % alert(s) — the split did not take', v_cnt;
      end if;

      -- 4. IT CAN GO RED. Create the failure, deploy, require exactly one
      -- warning naming it. Data-independent: the probe creates the condition
      -- rather than hoping the database contains one, because by (1) it does
      -- not contain one.
      update public.employees set blacklisted = true where id = v_emp2;

      insert into public.deployments (company_id, guard_id, client_id, start_date, end_date)
      values (v_co, v_emp2, v_cli, current_date, current_date + 30);

      select count(*), max(tier::text), max(message) into v_cnt, v_tier, v_msg
        from public.alerts where category = 'deploy_unverified_guard';
      if v_cnt <> 1 then
        raise exception '0297 FAILED: a blacklisted guard deployed raised % alert(s), expected 1', v_cnt;
      end if;
      if v_tier <> 'warning' then
        raise exception '0297 FAILED: tier is %, expected warning — the decision was explicit (0296)', v_tier;
      end if;
      if v_msg not like '%blacklisted%' then
        raise exception '0297 FAILED: the alert does not name the failure: %', v_msg;
      end if;
      -- The gaps must not have leaked into the message.
      if v_msg like '%not weapons-certified%' or v_msg like '%not on file%' then
        raise exception '0297 FAILED: a data-entry gap appears in the alert text: %', v_msg;
      end if;

      -- 5. THE RETURN CONTRACT DID NOT CHANGE. The screen that shows one guard
      -- must still see the gaps.
      if coalesce(array_length(public.check_deploy_guard(v_emp2), 1), 0)
         <> coalesce(array_length(public.armed_post_blockers(v_emp2), 1), 0) then
        raise exception '0297 FAILED: check_deploy_guard no longer returns the full blocker list';
      end if;

      update public.employees set blacklisted = false where id = v_emp2;

      -- 6. NO LONGER UNINVOKED. 0296 asserted this function WAS still
      -- uninvoked; that assertion is now deliberately inverted.
      if exists (select 1 from public.uninvoked_controls()
                  where object_name = 'check_deploy_guard') then
        raise exception '0297 FAILED: check_deploy_guard is still reported as uninvoked';
      end if;

      -- 7. THE TENANT GUARDS SURVIVED.
      select count(*) into v_cnt from public.tenant_guard_gaps();
      if v_cnt <> 0 then
        raise exception '0297 FAILED: tenant_guard_gaps() reports % gap(s)', v_cnt;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0297 verification failed: %', v_outcome;
  end if;
end
$verify$;
