-- 0273 — An outgoing CASH cheque must name the custodian who receives the money.
--
-- 0268 required a custodian on every cash movement in expenses,
-- invoice_payments, advances and payslips. `cheques` was not in that list, and
-- the omission is not cosmetic: sync_cheque_journal() falls back to
-- cash_account_for(company, null), which resolves to the undifferentiated cash
-- CONTROL account. So a cash cheque with no custodian posts money into company
-- cash attributable to nobody — the exact G2 defect, re-entering through the one
-- door 0268 did not close.
--
-- It was found by trying to prove the new every_source_row_posted check could
-- fail: a cash cheque with a null custodian was inserted expecting it to decline
-- to post, and it posted. The check did not fail; the schema did.
--
-- CHECK, not NOT NULL, for the reason 0268 gives: the requirement is
-- conditional. An INCOMING cheque has no custodian — it is banked, not carried
-- — and a PAYMENT cheque settles an item that carries its own attribution.

do $$
declare v_n bigint;
begin
  select count(*) into v_n from public.cheques
   where cheque_type = 'cash' and direction = 'outgoing' and custodian_location_id is null;
  if v_n > 0 then
    raise exception '0273: % outgoing cash cheque(s) name no custodian — attribute them before this constraint can hold', v_n;
  end if;
end $$;

alter table public.cheques
  drop constraint if exists cheques_cash_names_a_custodian;

alter table public.cheques
  add constraint cheques_cash_names_a_custodian
  check (cheque_type <> 'cash' or direction <> 'outgoing' or custodian_location_id is not null);

comment on constraint cheques_cash_names_a_custodian on public.cheques is
  'An outgoing cash cheque hands money to a named custodian. Without one the clearing posts to the undifferentiated cash control and the money is attributable to nobody (0273; the door 0268 left open).';

-- Prove it refuses. A constraint nobody has seen reject anything is a comment.
do $$
declare v_refused boolean := false;
begin
  begin
    insert into public.cheques (company_id, branch_id, bank_account_id, cheque_number, cheque_date,
                                cheque_type, direction, status, amount, recipient, custodian_location_id)
    select company_id, branch_id, bank_account_id, '0273-PROOF', cheque_date,
           'cash', 'outgoing', 'pending', 1.00, 'constraint proof', null
      from public.cheques limit 1;
  exception
    when check_violation then v_refused := true;
    when others then
      raise exception '0273: the proof insert failed for the wrong reason: % %', sqlstate, sqlerrm;
  end;

  if not v_refused then
    raise exception '0273: a custodian-less outgoing cash cheque was ACCEPTED — the constraint does not hold';
  end if;
  raise notice '0273: constraint proved able to refuse';
end $$;