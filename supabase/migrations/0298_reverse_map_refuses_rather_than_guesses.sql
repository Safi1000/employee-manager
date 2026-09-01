-- 0298 — the reverse map stops guessing. An ambiguous employee insert raises.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE DEFECT
--
-- sync_status_from_lifecycle() runs BEFORE INSERT. When the caller leaves
-- lifecycle_state at its 'active' default it derives lifecycle from status:
--
--   'Active'    -> active
--   'On Leave'  -> on_leave
--   ELSE        -> 'left'          <-- this line
--
-- 'left' means resigned. The else arm therefore turns every status that is not
-- one of those two — in practice 'Inactive', which is the natural thing to
-- write for an applicant — into a SEPARATION RECORD. Inactive is the stored
-- status of FIVE distinct lifecycle states (applicant, waitlisted, left,
-- fired, terminated, archived, absconded), and the map picks one of them.
--
-- A guess that is wrong loudly is a bug. A guess that silently manufactures a
-- resignation for someone who was never employed is a fabricated record, and
-- nothing downstream can tell it from a real one.
--
-- HOW MANY WERE FABRICATED: NONE. MEASURED, NOT ASSUMED.
--
-- Production audit_log, all 381 employee inserts ever recorded:
--
--   landed 'active'                 197   status 'Active'
--   lifecycle not recorded          173   status 'Active'  (pre-column inserts)
--   landed 'waitlisted'               2   caller set it explicitly
--   landed 'applicant'                2   caller set it explicitly
--   landed 'on_leave'                 2
--   landed 'absconded'/'fired'/
--          'terminated'/'archived'    4   caller set it explicitly
--   landed 'left'                     1
--
-- That single 'left' insert is EMP-0063 Sohail Tanvir on SANDBOX TESTING ORG,
-- a deliberate seed carrying exit_date, last_working_day, termination_date and
-- separation_reason = 'resignation'. It is a real separation, not a guess.
--
-- Cross-checked from the other direction on BOTH databases: every employee in
-- a separated state carries separation evidence. Zero rows have a separation
-- state and no exit date, last working day, termination date or reason.
--
-- So the defect never fired. This closes it while that is still true, which is
-- the only comfortable time — the same argument as 0290 and 0295.
--
-- REFUSING BREAKS NOTHING. ALSO MEASURED.
--
-- The only application insert path is EmployeeManagement.tsx's Add modal. It
-- does NOT send `status` at all: it sends `lifecycle_state` when the intake is
-- an applicant or waitlisted, and otherwise sends neither, so both column
-- defaults apply ('Active' / 'active') and the unambiguous arm handles it.
-- Grepping src/, supabase/functions/ and scripts/ for an insert supplying
-- 'Inactive' or 'On Leave' as status returns nothing.
--
-- WHAT NOW RAISES
--
-- An INSERT that leaves lifecycle_state at 'active' and supplies a status that
-- is not 'Active' or 'On Leave'. The message names the states the caller has
-- to choose between, because a refusal that does not say what to do instead is
-- an obstacle rather than a guard.
--
-- One case is worth stating because it looks like a false positive and is not:
-- an insert that sets lifecycle_state = 'active' EXPLICITLY and status =
-- 'Inactive' also raises. The trigger cannot distinguish an explicit 'active'
-- from the default, and that insert is self-contradictory anyway — it asks for
-- an employee who is simultaneously in service and not. Raising is right for
-- both readings.
--
-- UPDATE is untouched. It has always been forward-only: lifecycle_state
-- decides status, and there is nothing to guess.

create or replace function public.sync_status_from_lifecycle()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- On INSERT the two can disagree because existing insert paths write `status`
  -- and know nothing about lifecycle_state. If the caller left lifecycle_state
  -- at its 'active' default, derive lifecycle from the status they gave —
  -- BUT ONLY WHERE THAT IS UNAMBIGUOUS. If they set a non-default
  -- lifecycle_state, they are lifecycle-aware: drive status from it.
  if tg_op = 'INSERT' and new.lifecycle_state = 'active' then
    if new.status = 'Active' then
      new.lifecycle_state := 'active'::public.employee_lifecycle_state;
    elsif new.status = 'On Leave' then
      new.lifecycle_state := 'on_leave'::public.employee_lifecycle_state;
    else
      -- 0298. Refuse rather than guess. This arm used to assign 'left', which
      -- silently manufactured a resignation for an applicant. See the header.
      raise exception
        'Ambiguous employee insert: status % does not determine a lifecycle_state. Set lifecycle_state explicitly — applicant, waitlisted, left, fired, terminated, absconded or archived all store as Inactive.',
        coalesce(new.status, '<null>')
        using errcode = '22023';
    end if;
  end if;

  new.status := case new.lifecycle_state
    when 'active'   then 'Active'
    when 'on_leave' then 'On Leave'
    else 'Inactive'   -- applicant, waitlisted, left, terminated are all not-active
  end;
  return new;
end;
$function$;

comment on function public.sync_status_from_lifecycle() is
  'Keeps employees.status derived from lifecycle_state. On INSERT it will also derive lifecycle_state from a supplied status, but ONLY for Active and On Leave: every other status maps to seven possible lifecycle states and the previous else-arm guessed left, fabricating a resignation. It now raises 22023 naming the choices. UPDATE is forward-only and unchanged. See 0298.';

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_id uuid; v_ls text; v_st text; v_err text; v_sqlstate text;
      v_accepted boolean;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 0. NO EXISTING ROW WAS FABRICATED BY THE OLD ARM. A separated employee
      -- with no exit date, no last working day, no termination date and no
      -- reason is what a guessed separation looks like.
      --
      -- RUN FIRST, BEFORE ANY PROBE WRITES. An earlier version ran this last
      -- and failed — on the row check 6 had just created, an employee updated
      -- to 'fired' with no separation evidence because a fixture does not fill
      -- in a leaving date. My probe, not the data. A survey of existing rows
      -- has to be taken before the block starts adding rows to the population
      -- it is surveying.
      if exists (
        select 1 from public.employees e
         where e.lifecycle_state in ('left','fired','terminated','absconded')
           and e.exit_date is null and e.last_working_day is null
           and e.termination_date is null and e.separation_reason is null
      ) then
        raise exception '0298 FAILED: separated employees exist with no separation evidence — review before shipping, some may be fabricated';
      end if;

      -- 1. THE UNAMBIGUOUS ARMS STILL WORK. Defaults only: this is exactly
      -- what EmployeeManagement.tsx's Add modal sends, so if this breaks the
      -- application cannot create an employee at all.
      insert into public.employees (company_id, full_name)
      values (v_co, 'ZZ 0298 default') returning id into v_id;
      select lifecycle_state::text, status into v_ls, v_st
        from public.employees where id = v_id;
      if v_ls <> 'active' or v_st <> 'Active' then
        raise exception '0298 FAILED: default insert landed % / %, expected active / Active', v_ls, v_st;
      end if;

      insert into public.employees (company_id, full_name, status)
      values (v_co, 'ZZ 0298 on leave', 'On Leave') returning id into v_id;
      select lifecycle_state::text into v_ls from public.employees where id = v_id;
      if v_ls <> 'on_leave' then
        raise exception '0298 FAILED: status On Leave produced lifecycle %, expected on_leave', v_ls;
      end if;

      -- 2. THE FORWARD MAP IS UNTOUCHED. A lifecycle-aware caller still gets
      -- the state they asked for, and the derived status.
      insert into public.employees (company_id, full_name, lifecycle_state)
      values (v_co, 'ZZ 0298 applicant', 'applicant') returning id into v_id;
      select lifecycle_state::text, status into v_ls, v_st
        from public.employees where id = v_id;
      if v_ls <> 'applicant' or v_st <> 'Inactive' then
        raise exception '0298 FAILED: explicit applicant landed % / %', v_ls, v_st;
      end if;

      -- And a genuine separation supplied explicitly still inserts.
      insert into public.employees (company_id, full_name, lifecycle_state, status)
      values (v_co, 'ZZ 0298 real leaver', 'left', 'Inactive') returning id into v_id;
      select lifecycle_state::text into v_ls from public.employees where id = v_id;
      if v_ls <> 'left' then
        raise exception '0298 FAILED: an explicit left insert landed %', v_ls;
      end if;

      -- 3. THE REFUSAL. Asserted on the MESSAGE, not on the fact that
      -- something raised — three tests in this codebase have passed against
      -- the wrong trigger for exactly that reason (TENANT_GUARD_REPORT 7).
      --
      -- A FLAG, not a raise, inside the probe: raising here would be caught by
      -- this block's own handler and reported as "the wrong error", which is a
      -- true failure with a misleading reason.
      v_accepted := false;
      begin
        insert into public.employees (company_id, full_name, status)
        values (v_co, 'ZZ 0298 applicant by status', 'Inactive');
        v_accepted := true;
      exception when others then
        v_err := sqlerrm;
        v_sqlstate := sqlstate;
      end;

      if v_accepted then
        raise exception '0298 FAILED: status Inactive with no lifecycle_state was ACCEPTED — the else-arm still guesses';
      end if;

      if v_err not like 'Ambiguous employee insert%' then
        raise exception '0298 FAILED: the insert raised, but with the wrong error — %', v_err;
      end if;
      if v_err not like '%applicant%' or v_err not like '%waitlisted%' then
        raise exception '0298 FAILED: the refusal does not name the states to choose between: %', v_err;
      end if;
      if v_sqlstate <> '22023' then
        raise exception '0298 FAILED: sqlstate is %, expected 22023', v_sqlstate;
      end if;

      -- 4. AND IT WAS NOT ACCEPTED. A refusal that raises after writing is not
      -- a refusal.
      if exists (select 1 from public.employees
                  where company_id = v_co and full_name = 'ZZ 0298 applicant by status') then
        raise exception '0298 FAILED: the row was written despite the refusal';
      end if;

      -- 5. THE SELF-CONTRADICTORY INSERT ALSO RAISES, and this is deliberate:
      -- an explicit lifecycle_state = 'active' is indistinguishable from the
      -- default, and 'active' with status Inactive asks for an employee who is
      -- both in service and not.
      v_accepted := false;
      begin
        insert into public.employees (company_id, full_name, lifecycle_state, status)
        values (v_co, 'ZZ 0298 contradiction', 'active', 'Inactive');
        v_accepted := true;
      exception when others then
        v_err := sqlerrm;
      end;
      if v_accepted then
        raise exception '0298 FAILED: active + Inactive was accepted';
      end if;
      if v_err not like 'Ambiguous employee insert%' then
        raise exception '0298 FAILED: the contradictory insert raised the wrong error — %', v_err;
      end if;

      -- 6. UPDATE IS UNTOUCHED. Moving lifecycle_state on an existing row must
      -- still drive status, with no refusal anywhere near it.
      insert into public.employees (company_id, full_name)
      values (v_co, 'ZZ 0298 update path') returning id into v_id;
      update public.employees set lifecycle_state = 'fired' where id = v_id;
      select status into v_st from public.employees where id = v_id;
      if v_st <> 'Inactive' then
        raise exception '0298 FAILED: update to fired left status as %', v_st;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0298 verification failed: %', v_outcome;
  end if;
end
$verify$;
