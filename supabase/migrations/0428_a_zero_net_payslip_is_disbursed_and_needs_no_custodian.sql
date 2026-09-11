-- 0428: a payslip whose net is zero is already settled. Let it be marked
-- disbursed without naming a cash custodian, and mark the four that exist.
--
-- REPORTED AS: "Those with net salary = 0 should be automatically disbursed
-- considering their salary has already been paid in advance."
--
-- ---------------------------------------------------------------------------
-- WHY THEY COULD NOT BE
-- ---------------------------------------------------------------------------
-- Two separate things were stopping it, and only the first is obvious.
--
-- 1. THE FRONTEND DERIVATION. Both places that decide the flag read
--    `paid > 0 && paid >= net`. The `paid > 0` half was there to stop an
--    untouched payslip reading as disbursed — but `paid >= net` already refuses
--    that (0 >= 5000 is false). The ONLY rows `paid > 0` actually excludes are
--    the ones where net <= 0, which is precisely the case it should admit. A
--    guard that changes the answer only for the case it was not written about.
--    Fixed in PayrollManagement.tsx alongside this file.
--
-- 2. THIS CONSTRAINT. `payslips_disbursed_cash_names_a_location` requires a
--    custodian on any disbursed Cash payslip:
--
--        payment_mode <> 'Cash' OR NOT disbursed OR custodian_location_id IS NOT NULL
--
--    All four zero-net payslips are Cash with no custodian, so flipping the flag
--    would have traded one constraint error for another.
--
-- ---------------------------------------------------------------------------
-- WHY RELAXING IT IS CORRECT AND NOT A WEAKENING
-- ---------------------------------------------------------------------------
-- The custodian is demanded because CASH PHYSICALLY CHANGED HANDS and the
-- ledger has to post the credit to the person who handed it over — 0317 exists
-- because eight cash payslips posted to the undifferentiated cash control for
-- want of exactly this. That reasoning is about money moving.
--
-- When net is zero no cash moves. There is nobody who handed anything over, so
-- there is no attribution to make and no account to get wrong. Demanding a
-- custodian there does not protect anything; it asks the user to name a person
-- who did not do anything.
--
-- THE LEDGER ALREADY DRAWS EXACTLY THIS LINE, which is the strongest argument
-- that it is the right one. post_payslip_disbursement() opens with:
--
--     if not found or not ps.disbursed or coalesce(ps.net_salary, 0) = 0
--       then return; end if;
--
-- So a zero-net disbursement posts NOTHING — no journal, no settlement account,
-- no custodian read. The constraint was demanding an input for a code path that
-- returns before it ever looks at it.
--
-- The relaxation is therefore exactly as narrow as that early return: net = 0.
-- One rupee of net and the custodian is required again, unchanged.
--
-- NOT TOUCHED, DELIBERATELY: `payslips_paid_not_over_accrued`
-- (amount_paid <= net_salary). That one is a real control — 0277 added it after
-- 88,467 was paid against days that were never accrued — and nothing here needs
-- it weakened: these payslips pay zero against a net of zero, which satisfies it
-- already. If it is refusing a save, the save is wrong, not the constraint.

-- ---------------------------------------------------------------------------
-- 1. Narrow the constraint by the same condition the ledger uses
-- ---------------------------------------------------------------------------
alter table public.payslips
  drop constraint if exists payslips_disbursed_cash_names_a_location;

alter table public.payslips
  add constraint payslips_disbursed_cash_names_a_location
  check (
    payment_mode <> 'Cash'
    or not disbursed
    or coalesce(net_salary, 0) = 0
    or custodian_location_id is not null
  );

comment on constraint payslips_disbursed_cash_names_a_location on public.payslips is
  'A disbursed CASH payslip must name the custodian who handed the cash over, so the '
  'ledger credits that person rather than the undifferentiated cash control (0317). '
  'Exempt at net_salary = 0 (0428): no cash moves, there is nobody to attribute, and '
  'post_payslip_disbursement() returns before reading the custodian at all.';

-- ---------------------------------------------------------------------------
-- 2. The four that exist
-- ---------------------------------------------------------------------------
-- Two kinds of zero, and the same answer for both:
--   * EMP-0179 and EMP-0180 — final_salary 50,000 / 45,000 fully consumed by an
--     advance of the same amount. Paid, in advance, exactly as reported.
--   * GGS-00463 and GGS-00224 — final_salary 0 and no advance: they earned
--     nothing this month.
-- Different stories, identical obligation: nothing is owed, so nothing is
-- outstanding, so the payslip is not Pending. Marking them Pending for ever is
-- what made the not-disbursed list unfinishable.
do $$
declare
  v_before int;
  v_after  int;
  v_moved  int;
begin
  select count(*) into v_before
  from public.payslips where round(coalesce(net_salary, 0)) = 0 and not disbursed;

  update public.payslips
     set disbursed = true,
         disbursed_at = coalesce(disbursed_at, now()),
         status = 'Cleared'
   where round(coalesce(net_salary, 0)) = 0
     and not disbursed
     -- Belt and braces: never touch a row that has actually been paid money.
     -- A net of zero with a non-zero amount_paid is a different defect and this
     -- file has no business quietly closing it.
     and coalesce(amount_paid, 0) = 0;
  get diagnostics v_moved = row_count;

  select count(*) into v_after
  from public.payslips
  where round(coalesce(net_salary, 0)) = 0 and not disbursed and coalesce(amount_paid, 0) = 0;

  if v_after <> 0 then
    raise exception '0428: % zero-net payslips are still Pending after the update', v_after;
  end if;
  raise notice '0428: marked % of % zero-net payslips disbursed', v_moved, v_before;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Prove the constraint still refuses what it is for
-- ---------------------------------------------------------------------------
-- Relaxing a control and then asserting that the rows went through proves only
-- that it was relaxed. The question is whether it still REFUSES a disbursed
-- cash payslip with real money and no custodian — the thing 0317 was written
-- about. Tested against synthetic failure, rolled back.
do $$
declare
  v_id      uuid;
  v_refused boolean := false;
begin
  select id into v_id
  from public.payslips
  where payment_mode = 'Cash' and net_salary > 0
  limit 1;

  if v_id is null then
    raise exception '0428: no cash payslip with a non-zero net — the guard cannot be proved';
  end if;

  begin
    update public.payslips
       set disbursed = true, custodian_location_id = null
     where id = v_id;
  exception
    when check_violation then
      -- Assert on the REFUSAL'S IDENTITY, not merely that something raised:
      -- three separate tests in this project once passed against the wrong
      -- trigger for want of this.
      if sqlerrm like '%payslips_disbursed_cash_names_a_location%' then
        v_refused := true;
      else
        raise;
      end if;
  end;

  if not v_refused then
    raise exception
      '0428: a disbursed cash payslip with real net and no custodian was ACCEPTED — the guard is gone';
  end if;

  raise exception 'ROLLBACK_PROBE_OK';
exception
  when others then
    if sqlerrm = 'ROLLBACK_PROBE_OK' then
      raise notice '0428: guard verified — still refuses a cash disbursement with no custodian';
    else
      raise;
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
