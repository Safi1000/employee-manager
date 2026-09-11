-- 0427: make employees.contract_id follow employees.contract_line_id
-- automatically, and backfill the 198 rows where it never got set.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- An employee carries TWO links to a contract: `contract_id` (the header) and
-- `contract_line_id` (the specific post). The second determines the first —
-- contract_lines.contract_id — so `contract_id` is a SECOND COPY OF A FACT, and
-- it is the copy nobody maintains.
--
-- Measured before this ran, across live posted guards:
--
--     no contract_id ............................. 211
--     ...of which DO carry a contract_line_id .... 198
--     genuinely attached to nothing ..............  13
--     contract_id disagreeing with its line ......   0
--
-- Zero disagreements, because nothing ever writes a wrong value. It writes NO
-- value. And that is worse than a disagreement here, because `contract_id` is
-- read as the first arm of a fallback chain — resolveEobiAmount(contract,
-- client) — where ABSENT does not mean "unknown, go and look", it means "this
-- guard has no contract", and the chain silently routes to a different answer.
--
-- That is how one client ended up paying two different EOBI figures in the same
-- month: 2 Emaar guards with a contract_id resolved 400, 68 with only a line
-- resolved 370. See 0425 (HMC, 107 guards at zero) and 0426 (Emaar, settled at
-- 400 going forward).
--
-- ---------------------------------------------------------------------------
-- WHY IT HAPPENS, AND WHY PATCHING THE CALLER IS THE WRONG FIX
-- ---------------------------------------------------------------------------
-- `change_client()` writes contract_line_id and never touches contract_id. So
-- does the site/post editor on Employee Assignments. The bulk "Assign
-- employees" flow and the employee form write BOTH. A guard's contract_id
-- therefore depends on WHICH CODE PATH LAST TOUCHED THEM, which is not a rule
-- anybody could have known they were relying on.
--
-- The obvious fix is to add `contract_id` to change_client. That fixes the
-- writer that was found, and leaves every other writer — two frontend forms
-- doing direct .update(), change_category, whatever is written next — free to
-- reintroduce it. A denormalised column maintained by convention decays back to
-- this state; it has already done so 198 times.
--
-- So the column is made DERIVED instead. A BEFORE trigger sets it from the line
-- on every insert and every update that touches either column, so no caller can
-- get it wrong and no caller has to remember. `contract_id` stops being a field
-- anybody maintains and becomes a cached read of the line.
--
-- This is the same shape, and the same remedy, as
-- `trg_zzz_employees_sync_branch_from_client` on this very table: a
-- denormalised column that has one true source, kept true by a trigger rather
-- than by every writer agreeing to be careful.
--
-- WHAT IT DOES NOT DO. With NO line, contract_id is left exactly as it is. A
-- guard can legitimately be attached to a contract without being pinned to a
-- particular post (one such row exists today), and clearing that would destroy
-- information the trigger has no better source for. The rule is one-directional:
-- a line, when present, decides the contract. Silence decides nothing.

-- ---------------------------------------------------------------------------
-- 1. The rule
-- ---------------------------------------------------------------------------
create or replace function public.employees_sync_contract_from_line()
returns trigger
language plpgsql
as $function$
begin
  if new.contract_line_id is not null then
    select cl.contract_id into new.contract_id
      from public.contract_lines cl
     where cl.id = new.contract_line_id;
  end if;
  -- No line: leave contract_id alone. See the header — absence of a post is not
  -- evidence of absence of a contract.
  return new;
end;
$function$;

comment on function public.employees_sync_contract_from_line() is
  'employees.contract_id is DERIVED from contract_line_id (0427), never maintained by '
  'callers. A line decides the contract; no line decides nothing. Added because '
  'change_client() and the post editor wrote only the line, leaving 198 guards with a '
  'null contract_id that read as "no contract" in resolveEobiAmount''s first arm.';

drop trigger if exists trg_zzz_employees_sync_contract_from_line on public.employees;
create trigger trg_zzz_employees_sync_contract_from_line
  before insert or update of contract_line_id, contract_id on public.employees
  for each row execute function public.employees_sync_contract_from_line();

-- ---------------------------------------------------------------------------
-- 2. The backfill
-- ---------------------------------------------------------------------------
-- Checked before writing, across LIVE posted guards: every blank row's line
-- belongs to the employee's OWN client (0 cross-client) and every target
-- contract is active (0 inactive). So for them this records a value that was
-- already true and merely unwritten — it moves no serving guard between
-- contracts. (One SEPARATED record does move; see the refusal note below, and
-- note that the survey missing it is the whole reason that note exists.)
--
-- The EOBI consequence was settled first, deliberately: 0426 aligned Emaar's
-- two arms to 400, so the 68 Emaar guards this touches resolve to the same
-- figure before and after. Without that, this "data consistency" statement
-- would have quietly changed 68 people's take-home pay.
--
-- REFUSED ONCE, AND THE REFUSAL WAS RIGHT. The first version of this block
-- filled only the NULL rows and then asserted that nothing in the table
-- disagreed with its line. It failed on one row — GGS-00500, fired, sitting at
-- Dolmen City with a contract_id pointing at ANOTHER CLIENT'S contract while
-- their line pointed at Dolmen's. A stale pointer left behind by a client move
-- that set the line and not the header: the same defect as the 198 blanks,
-- one step further along, because here the wrong value is present rather than
-- absent.
--
-- So the backfill is written the way the TRIGGER behaves — the line decides,
-- whatever contract_id currently says — rather than only where it says nothing.
-- Anything narrower would leave a row the trigger would silently rewrite on its
-- next update anyway, which is a difference nobody should have to discover.
-- Verified before widening: zero LIVE employees disagree, so the only row this
-- arm corrects is that one separated record.
do $$
declare
  v_blank     int;
  v_wrong     int;
  v_touched   int;
  v_after     int;
begin
  select count(*) filter (where e.contract_id is null),
         count(*) filter (where e.contract_id is not null and e.contract_id <> cl.contract_id)
    into v_blank, v_wrong
  from public.employees e
  join public.contract_lines cl on cl.id = e.contract_line_id;

  update public.employees e
     set contract_id = cl.contract_id
    from public.contract_lines cl
   where cl.id = e.contract_line_id
     and e.contract_id is distinct from cl.contract_id;
  get diagnostics v_touched = row_count;

  raise notice '0427: % rows aligned to their line (% were blank, % pointed elsewhere)',
    v_touched, v_blank, v_wrong;

  -- The real assertion. Not "rows were updated" — that was never in doubt — but
  -- that no row anywhere still contradicts its own line. Tested across the whole
  -- table, separated staff included, rather than only the rows just written:
  -- restricting it to live employees is precisely how the stale row above stayed
  -- invisible in the survey that preceded this file.
  select count(*) into v_after
  from public.employees e
  join public.contract_lines cl on cl.id = e.contract_line_id
  where e.contract_id is distinct from cl.contract_id;
  if v_after <> 0 then
    raise exception '0427: % employees still disagree with their own contract line', v_after;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Prove the trigger actually fires
-- ---------------------------------------------------------------------------
-- A backfill plus a trigger that silently does nothing looks identical to a
-- backfill plus a working trigger — until the next change_client() call six
-- months from now quietly re-opens the gap. Asserting that the trigger EXISTS
-- would be a proxy, not a test: the failure to guard against is "it is attached
-- and does not populate the column", and nothing in pg_trigger can see that.
--
-- So it is exercised against a real row. The probe deliberately does NOT move
-- anybody to a different line — it rewrites the employee's EXISTING line back
-- onto itself while nulling contract_id in the same statement. That fires the
-- trigger (both columns are in its UPDATE OF list) and forces it to repopulate
-- the column from the line, while leaving every other trigger on this table
-- looking at an unchanged posting, so the headcount, ops-verified and
-- assignment-permission guards have nothing to refuse. Rolled back regardless.
do $$
declare
  v_emp      uuid;
  v_expected uuid;
  v_got      uuid;
begin
  select e.id, cl.contract_id
    into v_emp, v_expected
  from public.employees e
  join public.contract_lines cl on cl.id = e.contract_line_id
  where e.lifecycle_state not in ('terminated', 'fired', 'left', 'absconded')
    and cl.contract_id is not null
  limit 1;

  if v_emp is null then
    raise exception '0427: no employee carries a contract line — the trigger cannot be verified';
  end if;

  -- contract_id is blanked and the line is restated in ONE statement. Only the
  -- trigger can put the value back.
  update public.employees e
     set contract_id = null,
         contract_line_id = e.contract_line_id
   where e.id = v_emp;

  select contract_id into v_got from public.employees where id = v_emp;

  if v_got is null then
    raise exception
      '0427: the trigger did not fire — contract_id stayed null after a line write';
  end if;
  if v_got is distinct from v_expected then
    raise exception
      '0427: the trigger derived the wrong contract — expected %, got %', v_expected, v_got;
  end if;

  -- Everything above was a probe against live data. Undo it. Raising is what
  -- rolls this block's subtransaction back; the handler below is what stops the
  -- rollback from failing the migration.
  raise exception 'ROLLBACK_PROBE_OK';
exception
  when others then
    if sqlerrm = 'ROLLBACK_PROBE_OK' then
      raise notice '0427: trigger verified — a line-only write repopulated contract_id';
    else
      -- Any other error is real. Do not swallow it: a probe that reports success
      -- because it could not run is the failure mode this project exists to
      -- remove.
      raise;
    end if;
end;
$$;

-- The probe rolls itself back by raising. Confirm that rather than trusting it:
-- a check that leaked its own test write into a payroll-bearing table would be a
-- defect introduced by the checking.
do $$
declare v_n int;
begin
  select count(*) into v_n
  from public.employees e
  join public.contract_lines cl on cl.id = e.contract_line_id
  where e.contract_id is distinct from cl.contract_id;
  if v_n <> 0 then
    raise exception '0427: % rows inconsistent after the probe — it did not roll back', v_n;
  end if;
end;
$$;

do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
