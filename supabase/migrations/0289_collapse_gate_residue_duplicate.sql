-- 0289 — One implementation of the gate-mode residue rule, not two.
--
-- DEV ONLY.
--
-- THE DUPLICATE
--
-- The rule "no attendance row is left in the gate-mode 'blocked' status" is
-- written twice:
--
--   attendance_gate_mode_residue(p_company_id)   — per employee, with dates.
--                                                  Referenced only by
--                                                  supabase/tests/attendance_status.sql.
--                                                  Nothing in the running
--                                                  system calls it.
--   ledger_checks_base                           — recomputes the same
--                                                  condition inline as a raw
--                                                  row count.
--
-- One is invoked and one is not, and nothing forces them to agree. That is the
-- shape that produced two answers to one question when partner_client_breakdown
-- defaulted to 'revenue' while partnership_allocation fell back to region
-- profit. The uninvoked copy is where drift accumulates unseen, because the
-- invoked copy is the only one anybody watches.
--
-- THEY DO NOT RETURN THE SAME NUMBER, AND THAT IS THE POINT
--
-- Worth stating precisely, because "same rule" hid a real difference:
--
--   inline    counts blocked ROWS
--   function  returns one row per EMPLOYEE, each carrying its own row count
--
-- Both are zero exactly when the other is, so the PASS/FAIL verdict has always
-- agreed. The reported `difference` has not. Collapsing naively onto the
-- function would silently change a published figure from "blocked rows" to
-- "employees with blocked rows" — a number in a report quietly meaning
-- something else, which is its own defect.
--
-- So the check sums the function's per-employee `rows`, which reproduces the
-- inline figure exactly. One implementation, same number, and the verification
-- below proves the number did not move rather than assuming it.
--
-- HOW
--
-- Surgery on the existing body rather than restating six hundred lines of
-- ledger_checks_base. Restating it would risk losing the 0287 tenant guard or
-- one of the 0259 subtree fixes to a copy-paste, and this file would then be
-- the authority on a function it had subtly altered.

do $collapse$
declare
  v_oid   oid;
  v_src   text;
  v_new   text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  p1      int;
  p2      int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks_base';

  if v_src ~ 'attendance_gate_mode_residue' then
    raise notice '0289: already collapsed, nothing to do';
    return;                                    -- idempotent replay
  end if;

  v_new := regexp_replace(
    v_src,
    'gate_residue as \(\s*select count\(\*\)::numeric n from public\.attendance_records a\s*where a\.company_id = p_company_id and a\.status = ''blocked''\s*\),',
    'gate_residue as ('
      || E'\n    -- 0289. ONE implementation. This counted blocked rows inline while'
      || E'\n    -- attendance_gate_mode_residue() computed the same condition per'
      || E'\n    -- employee and nothing called it. Summing the per-employee `rows`'
      || E'\n    -- reproduces the exact figure this check reported before.'
      || E'\n    select coalesce(sum(r."rows"), 0)::numeric n'
      || E'\n      from public.attendance_gate_mode_residue(p_company_id) r'
      || E'\n  ),',
    'g');

  if v_new = v_src then
    raise exception '0289 FAILED: the inline gate_residue CTE was not found — ledger_checks_base has changed shape, do not guess';
  end if;

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$collapse$;

-- ---------------------------------------------------------------------------
-- Verification.
--
-- Three things: the duplicate is gone, the number did not move, and the check
-- can still go red. The middle one is what makes this a refactor rather than a
-- change — a collapse that quietly alters a reported figure is not a collapse.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_inline numeric; v_now numeric; v_after numeric; v_rows int;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- 1. ledger_checks_base now CALLS the function.
      if not exists (select 1 from pg_proc p
                      where p.pronamespace='public'::regnamespace
                        and p.proname='ledger_checks_base'
                        and p.prosrc ~ 'attendance_gate_mode_residue\s*\(') then
        raise exception '0289 FAILED: ledger_checks_base does not call attendance_gate_mode_residue';
      end if;

      -- 2. The number is unchanged. Recompute the OLD inline expression by
      -- hand and require the check to still report exactly it.
      select count(*)::numeric into v_inline
        from public.attendance_records a
       where a.company_id = v_co and a.status = 'blocked';

      select actual into v_now from public.ledger_checks(v_co)
       where check_name = 'no_gate_mode_in_attendance_status';

      if v_now is distinct from v_inline then
        raise exception '0289 FAILED: the figure moved — inline said %, the collapsed check says %',
          v_inline, v_now;
      end if;

      -- 3. The suite still has the right shape and the canary is green.
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 21 then
        raise exception '0289 FAILED: ledger_checks returned % rows, expected 21', v_rows;
      end if;

      -- 4. The collapsed check READS THE FUNCTION. Proved by replacing the
      -- function with a stub that returns one synthetic row and requiring the
      -- ledger figure to follow it. Data-independent on purpose: an earlier
      -- version of this probe inserted a blocked attendance row and tripped an
      -- unrelated service-window trigger, which would have been my fixture
      -- failing dressed up as the collapse failing.
      declare
        v_before numeric; v_stubbed numeric; v_def text;
      begin
        select actual into v_before from public.ledger_checks(v_co)
         where check_name = 'no_gate_mode_in_attendance_status';

        v_def := pg_get_functiondef(
          (select p.oid from pg_proc p
            where p.pronamespace='public'::regnamespace
              and p.proname='attendance_gate_mode_residue'));

        execute $stub$
          create or replace function public.attendance_gate_mode_residue(p_company_id uuid)
          returns table(employee_id uuid, full_name text, guard_code text,
                        rows bigint, first_day date, last_day date, join_date date)
          language sql stable security definer set search_path to 'public'
          as $s$ select null::uuid, null::text, null::text, 7::bigint,
                         null::date, null::date, null::date $s$;
        $stub$;

        select actual into v_stubbed from public.ledger_checks(v_co)
         where check_name = 'no_gate_mode_in_attendance_status';

        execute v_def;   -- restore before judging, so a failure cannot leave a stub behind

        if v_stubbed is distinct from 7::numeric then
          raise exception 'PROBE INSENSITIVE: stubbed the function to report 7 and the check said % (was %)',
            v_stubbed, v_before;
        end if;

        select actual into v_stubbed from public.ledger_checks(v_co)
         where check_name = 'no_gate_mode_in_attendance_status';
        if v_stubbed is distinct from v_before then
          raise exception 'PROBE DID NOT RESTORE: figure is %, was %', v_stubbed, v_before;
        end if;
      end;

      -- 5. attendance_gate_mode_residue is no longer an uninvoked control.
      if exists (select 1 from public.uninvoked_controls()
                  where function_name = 'attendance_gate_mode_residue') then
        raise exception '0289 FAILED: attendance_gate_mode_residue is still reported as uninvoked';
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0289 verification failed: %', v_outcome;
  end if;
end
$verify$;
