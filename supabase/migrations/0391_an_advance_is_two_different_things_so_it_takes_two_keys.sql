-- 0391 — advances is gated per ROW SHAPE, and the payroll carry-forward stops
--         being a bare insert nobody reads.
--
-- ===========================================================================
-- THE QUESTION, AND WHY NEITHER KEY WAS THE ANSWER
-- ===========================================================================
--
-- advances had NO permission at all until 0372 put it behind expenses.edit,
-- explicitly provisionally — wrong key beats no key. The owed question was
-- which key it should really be. Reading the payroll side to ask it properly
-- gave a different answer: NEITHER, BECAUSE THE TABLE HOLDS TWO DIFFERENT
-- THINGS.
--
--   A DISBURSED ADVANCE is cash or bank actually handed to an employee against
--   future pay. It is a payment, it moves money, it is created on the Expenses
--   screen. expenses.edit — unchanged.
--
--   A CARRY-FORWARD (payment_mode = 'Carry-forward') moves NO money. It records
--   that a payslip overpaid someone and that the difference is owed. It is
--   created by payroll, from PayrollManagement, and recovered by payroll —
--   employee_advance_outstanding puts it on next month's payslip.
--   payroll.edit.
--
-- One key for the whole table locks out one of the two writers, whichever key
-- is chosen. So the policy asks what the ROW IS, not which screen wrote it.
--
-- ===========================================================================
-- THE LIVE DEFECT THIS ALSO CLOSES, WHICH 0372 CAUSED
-- ===========================================================================
--
-- syncOverpayAdvance in PayrollManagement.tsx issued its insert, update and
-- delete with NO ERROR CHECK AT ALL. Under 0372's expenses.edit policy:
--
--   a payroll operator without expenses.edit saves an overpaid payslip
--     -> the insert is refused by RLS: ZERO ROWS, NO ERROR
--     -> no carry-forward row exists
--     -> next month employee_advance_outstanding finds nothing to deduct
--     -> THE OVERPAYMENT IS SILENTLY WRITTEN OFF.
--
-- Real money the employee owes, gone, with nothing recording that it was. The
-- silent zero-row write, arriving inside the migration that was meant to be an
-- improvement. super_admin and SSA are waved through by has_perm(), so it bit
-- exactly the non-admin payroll operator the permission system exists for.
--
-- Production carries ZERO Carry-forward rows today, so nothing has been lost.
--
-- ===========================================================================
-- AND A THIRD FINDING, WHICH THE FIRST PROBE RUN TURNED UP
-- ===========================================================================
--
-- The carry-forward has ALSO been failing for a reason that has nothing to do
-- with permissions, and failing silently for the same reason.
--
-- trg_advances_not_future refuses any advance dated after today: "it records
-- something that has already happened". A carry-forward is dated the FIRST OF
-- THE FOLLOWING MONTH — which is load-bearing, not decorative:
-- employee_advance_outstanding(p) counts advances with
-- `advance_date < p + interval '1 month'`, so next-month dating is exactly what
-- keeps the row out of the payslip that created it and puts it into the next
-- one.
--
-- So saving an overpaid payslip at any time BEFORE the first of the following
-- month — the ordinary case, payroll run inside the month — raised, and
-- syncOverpayAdvance swallowed that too. The row has never been created in
-- that case, by anybody, regardless of permissions.
--
-- The exemption is narrow and the trigger's own words are the argument for it:
-- a disbursed advance is dated by WHEN THE MONEY CHANGED HANDS, and cannot be
-- in the future. A carry-forward is dated by WHEN IT BECOMES RECOVERABLE. The
-- date means a different thing for the two shapes, which is the same reason
-- they take different keys.
--
-- THE TWO HALVES SHIP TOGETHER ON PURPOSE. Fixing the swallowed error first
-- would turn a silent write-off into a hard payroll-save failure for the same
-- operator; widening the policy first would leave the error swallowed. Landing
-- them in one migration means the operator who could not create the row
-- silently can now create it legitimately.

-- ---------------------------------------------------------------------------
-- 1. THE POLICY SPLIT.
--
-- Note what the two halves of an UPDATE mean here: USING tests the row as it
-- STANDS and WITH CHECK tests the row as it WOULD BE. So converting a disbursed
-- advance into a carry-forward (or back) requires BOTH keys — which is correct,
-- and worth knowing rather than discovering: that edit changes whether money
-- was handed over, and it should not be within reach of either operator alone.
-- ---------------------------------------------------------------------------
do $$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public' and tablename = 'advances'
     and policyname in ('perm_write_ins', 'perm_write_upd', 'perm_write_del')
     and coalesce(qual, '') || coalesce(with_check, '') like '%expenses.edit%';
  if v_n <> 3 then
    raise exception
      '0391 REFUSED: expected 0372''s three expenses.edit policies on advances and found %. The body is not the one this migration was written against.', v_n;
  end if;
end $$;

drop policy perm_write_ins on public.advances;
drop policy perm_write_upd on public.advances;
drop policy perm_write_del on public.advances;

create policy perm_write_ins on public.advances for insert to authenticated
  with check (
    case when payment_mode = 'Carry-forward'
         then public.has_perm('payroll.edit')
         else public.has_perm('expenses.edit') end);

create policy perm_write_upd on public.advances for update to authenticated
  using (
    case when payment_mode = 'Carry-forward'
         then public.has_perm('payroll.edit')
         else public.has_perm('expenses.edit') end)
  with check (
    case when payment_mode = 'Carry-forward'
         then public.has_perm('payroll.edit')
         else public.has_perm('expenses.edit') end);

create policy perm_write_del on public.advances for delete to authenticated
  using (
    case when payment_mode = 'Carry-forward'
         then public.has_perm('payroll.edit')
         else public.has_perm('expenses.edit') end);

comment on table public.advances is
  '0372/0391: TWO ROW SHAPES, TWO KEYS, and the policy asks what the row IS rather than which screen wrote it. A DISBURSED advance (Cash/Bank/Cheque) is money handed to an employee against future pay — created on the Expenses screen, requires expenses.edit. A CARRY-FORWARD (payment_mode = ''Carry-forward'') moves no money at all: it records that a payslip overpaid someone, is created by payroll, and is recovered by payroll via employee_advance_outstanding — requires payroll.edit. One key for the whole table would lock out one of the two writers whichever key was chosen; 0372 chose expenses.edit provisionally and silently blocked payroll''s carry-forward. Changing a row from one shape to the other needs BOTH keys, because USING tests the old row and WITH CHECK the new one.';

-- ---------------------------------------------------------------------------
-- 1b. THE NOT-FUTURE TRIGGER LEARNS THE DIFFERENCE.
--
-- Narrowed with a WHEN clause rather than by editing enforce_not_future_date(),
-- which is shared by several tables and means exactly what it says for all of
-- them. The exemption is one row shape on one table, visible in the trigger
-- definition itself.
-- ---------------------------------------------------------------------------
drop trigger trg_advances_not_future on public.advances;

create trigger trg_advances_not_future
  before insert or update on public.advances
  for each row
  when (new.payment_mode is distinct from 'Carry-forward')
  execute function enforce_not_future_date('advance_date', 'advance');

-- ---------------------------------------------------------------------------
-- 2. THE RPC, replacing a bare insert whose failure nobody read.
--
-- SECURITY INVOKER: the policy above is the gate, restated nowhere. What this
-- adds is that every write ASSERTS ITS OWN ROW COUNT AND RAISES — the same
-- shape as apply_money_delta, and for the same reason. A zero-row write under
-- RLS is silence, and silence is what wrote the overpayment off.
--
-- The note string and the carry date move in here with it. They were computed
-- in the browser and are the KEY this row is found by on the next call; a
-- convention that identifies a row belongs where the row is written, not in
-- whichever component happens to be writing it. (No Carry-forward rows exist
-- yet, so there is no old format to stay compatible with.)
-- ---------------------------------------------------------------------------
create or replace function public.sync_overpayment_carry_forward(
  p_employee_id  uuid,
  p_period_month date,
  p_overpay      numeric
) returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare
  v_note   text;
  v_target numeric;
  v_date   date;
  v_id     uuid;
  v_amount numeric;
  v_n      int;
begin
  if p_employee_id is null or p_period_month is null then
    raise exception 'A carry-forward needs an employee and a period. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0242)
  perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));

  v_note   := 'Payroll overpayment carry-forward · ' || to_char(p_period_month, 'FMMonth YYYY');
  v_target := greatest(0, round(coalesce(p_overpay, 0)));
  v_date   := (date_trunc('month', p_period_month) + interval '1 month')::date;

  -- ONE marker row per (employee, period), found by its note. Reconciled to the
  -- current overpaid amount rather than added to, so re-saving a payslip does
  -- not stack duplicates and does not double-count against a manual advance.
  select id, amount into v_id, v_amount
    from public.advances
   where employee_id = p_employee_id and notes = v_note
   order by created_at
   limit 1;

  if v_target <= 0 then
    if v_id is null then return null; end if;
    delete from public.advances where id = v_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception
        'The overpayment carry-forward could not be removed — it needs the payroll.edit permission. Nothing has been recorded.'
        using errcode = '42501';
    end if;
    return null;
  end if;

  if v_id is not null then
    if round(coalesce(v_amount, 0)) = v_target then
      return v_id;   -- already correct; nothing to write
    end if;
    update public.advances
       set amount = v_target, advance_date = v_date, updated_at = now()
     where id = v_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception
        'The overpayment carry-forward could not be updated — it needs the payroll.edit permission. The payslip has not been saved.'
        using errcode = '42501';
    end if;
    return v_id;
  end if;

  -- 0317: NO MONEY MOVES here. This row records that the employee was overpaid
  -- and owes the difference; it is not a cash disbursement. payment_mode is
  -- 'Carry-forward' rather than 'Cash' precisely so the ledger does not post a
  -- credit against the cash control for money that never left the building —
  -- journal_on_advance skips Carry-forward entirely. It is also what selects
  -- payroll.edit rather than expenses.edit in the policy above.
  insert into public.advances
    (employee_id, amount, advance_date, payment_mode, notes)
  values
    (p_employee_id, v_target, v_date, 'Carry-forward', v_note)
  returning id into v_id;

  if v_id is null then
    raise exception
      'The overpayment carry-forward could not be recorded — it needs the payroll.edit permission. The payslip has not been saved.'
      using errcode = '42501';
  end if;
  return v_id;
end;
$function$;

comment on function public.sync_overpayment_carry_forward(uuid, date, numeric) is
  '0391: keeps ONE advance row carrying a payslip''s overpayment into the next month, where employee_advance_outstanding deducts it. Idempotent per (employee, period): reconciled to the current overpaid amount, removed when it reaches zero. SECURITY INVOKER — the advances policy is the gate and requires payroll.edit for a Carry-forward row. Every write asserts its own row count and raises: it replaces a bare insert/update/delete in PayrollManagement.tsx that checked no error at all, so under 0372''s expenses.edit-only policy a payroll operator got zero rows, no error, and the overpayment was silently written off.';

grant execute on function public.sync_overpayment_carry_forward(uuid, date, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- PROVE IT.
--
-- WHAT CANNOT BE PROVED HERE, said plainly: this session connects as an owner
-- that BYPASSES RLS, so neither the payroll.edit requirement nor the
-- expenses.edit one can be exercised from a migration. Borrowing a profile's
-- claim sets auth.uid() for has_perm(), but it does not make the connection
-- subject to the policies. So the policy half is asserted STRUCTURALLY — the
-- predicates say what they must — and the behavioural half is asserted by
-- running it.
--
-- The behaviour that IS provable is the one the frontend got wrong: idempotence
-- and removal. Two saves of the same payslip must leave one row, not two; a
-- changed amount must reconcile rather than stack; and an overpayment falling
-- to zero must take the row with it, or the employee is deducted for money they
-- no longer owe.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co   uuid;
  v_uid  uuid;
  v_emp  uuid;
  v_id1  uuid; v_id2 uuid;
  v_n    int;
  v_amt  numeric;
  v_pol  int;
begin
  -- Structural: all three policies must name BOTH keys, and none may still be
  -- expenses.edit alone. A split that only reached two of the three would leave
  -- one operation locked and would look fine from the other two.
  select count(*) into v_pol from pg_policies
   where schemaname = 'public' and tablename = 'advances'
     and policyname in ('perm_write_ins', 'perm_write_upd', 'perm_write_del')
     and coalesce(qual, '') || coalesce(with_check, '') like '%payroll.edit%'
     and coalesce(qual, '') || coalesce(with_check, '') like '%expenses.edit%'
     and coalesce(qual, '') || coalesce(with_check, '') like '%Carry-forward%';
  if v_pol <> 3 then
    raise exception '0391 FAILED: % of the three advances policies carry the split, expected 3.', v_pol;
  end if;

  select id into v_co from public.companies where name like 'GUARDS%' limit 1;
  select id into v_uid from public.profiles where company_id = v_co limit 1;
  select id into v_emp from public.employees where company_id = v_co limit 1;
  if v_co is null or v_uid is null or v_emp is null then
    raise exception '0391 FAILED: no company / profile / employee to probe against.';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);

  -- Create.
  v_id1 := public.sync_overpayment_carry_forward(v_emp, date '2026-09-01', 1234.4);
  if v_id1 is null then raise exception '0391 FAILED: the carry-forward was not created.'; end if;
  select amount into v_amt from public.advances where id = v_id1;
  if v_amt <> 1234 then
    raise exception '0391 FAILED: the carry-forward is % and should be 1234 (rounded).', v_amt;
  end if;
  if (select payment_mode from public.advances where id = v_id1) <> 'Carry-forward' then
    raise exception '0391 FAILED: the row is not a Carry-forward, so it would post to the cash ledger and take the wrong key.';
  end if;

  -- Re-save with the SAME figure: no second row, same id.
  v_id2 := public.sync_overpayment_carry_forward(v_emp, date '2026-09-01', 1234.4);
  if v_id2 is distinct from v_id1 then
    raise exception '0391 FAILED: re-saving produced a different row (% vs %).', v_id2, v_id1;
  end if;

  -- Re-save with a DIFFERENT figure: reconciled, not stacked.
  v_id2 := public.sync_overpayment_carry_forward(v_emp, date '2026-09-01', 900);
  select count(*) into v_n from public.advances
   where employee_id = v_emp and notes like 'Payroll overpayment carry-forward%';
  if v_n <> 1 then
    raise exception '0391 FAILED: % carry-forward row(s) after two saves, expected 1.', v_n;
  end if;
  select amount into v_amt from public.advances where id = v_id1;
  if v_amt <> 900 then
    raise exception '0391 FAILED: the carry-forward is % and should have reconciled to 900.', v_amt;
  end if;

  -- Overpayment gone: the row must go with it, or the employee is deducted for
  -- money they no longer owe.
  if public.sync_overpayment_carry_forward(v_emp, date '2026-09-01', 0) is not null then
    raise exception '0391 FAILED: a zero overpayment did not return null.';
  end if;
  select count(*) into v_n from public.advances
   where employee_id = v_emp and notes like 'Payroll overpayment carry-forward%';
  if v_n <> 0 then
    raise exception '0391 FAILED: % carry-forward row(s) remain after the overpayment cleared.', v_n;
  end if;

  -- And zero again is a no-op rather than an error: a payslip with no
  -- overpayment is saved far more often than one with.
  if public.sync_overpayment_carry_forward(v_emp, date '2026-09-01', 0) is not null then
    raise exception '0391 FAILED: a repeated zero did not return null.';
  end if;

  -- The exemption must be NARROW. A future-dated DISBURSED advance is still
  -- refused; if it were not, 1b would have turned a rule off rather than taught
  -- it a distinction.
  begin
    insert into public.advances (employee_id, amount, advance_date, payment_mode, notes)
    values (v_emp, 100, current_date + 30, 'Cash', 'PROBE 0391 future cash');
    raise exception '0391 FAILED: a future-dated CASH advance was accepted. The not-future rule was turned off, not narrowed.';
  exception when others then
    if sqlerrm not like '%date in the future%' then
      raise exception '0391 FAILED: the future-dated cash advance raised "%", not the refusal being tested.', sqlerrm;
    end if;
  end;

  raise exception
    'ROLLBACK_PROBE 0391 OK: three policies carry the split; create, re-save, reconcile and remove all keep exactly one row; a future-dated carry-forward is allowed and a future-dated cash advance is still refused. The permission halves cannot be exercised from an owner connection and are asserted structurally.';
exception when others then
  if sqlerrm not like 'ROLLBACK_PROBE%' then raise; end if;
  raise notice '%', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0391 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
