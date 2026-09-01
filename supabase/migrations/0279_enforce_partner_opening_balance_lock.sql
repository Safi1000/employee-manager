-- 0279 — `partners.opening_balance_locked` becomes a lock.
--
-- Until now it was a disabled input. `Partners.tsx` reads the flag and sets
-- `disabled` on the opening-balance and opening-date fields; the database
-- accepted any value from any other path — the REST API, a script, a second
-- client, a future screen that forgets. **A lock that exists only in the UI is
-- not a lock**, and this one guards a figure the ledger depends on: a partner's
-- opening balance is a cutover input, and changing it after the fact restates a
-- position that has already been reported.
--
-- Same pattern as enforce_contract_lock and enforce_payroll_run_lock: refuse the
-- change at the row, with a message that names the reason and the way out.
--
-- The flag itself can still be cleared — deliberately. This is a lock, not a
-- one-way door: someone with a reason can unlock, correct and re-lock, and the
-- audit trigger on `partners` records all three steps. Making the flag itself
-- immutable would turn a data-entry mistake into a permanent one.

create or replace function public.enforce_partner_opening_lock()
returns trigger
language plpgsql
as $function$
begin
  if not coalesce(old.opening_balance_locked, false) then
    return new;          -- not locked: nothing to enforce
  end if;

  if new.opening_balance is distinct from old.opening_balance
     or new.opening_balance_date is distinct from old.opening_balance_date then
    raise exception
      'Partner opening balance is locked and cannot be changed. Clear opening_balance_locked first, and expect the change to be audited. [partners]'
      using errcode = '23514',
            hint = 'The opening balance is a cutover input; changing it restates a position that has already been reported.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_partner_opening_lock on public.partners;
create trigger trg_partner_opening_lock
  before update on public.partners
  for each row execute function public.enforce_partner_opening_lock();

-- Prove it refuses, and prove it permits when unlocked. A lock nobody has seen
-- refuse anything is a comment; one nobody has seen ALLOW anything is an outage.
do $$
declare v_p uuid; v_bal numeric; v_was boolean; v_refused boolean := false;
begin
  select id, opening_balance, coalesce(opening_balance_locked, false)
    into v_p, v_bal, v_was
    from public.partners order by created_at limit 1;

  if v_p is null then
    raise notice '0279: no partner to test against';
    return;
  end if;

  update public.partners set opening_balance_locked = true where id = v_p;

  begin
    update public.partners set opening_balance = coalesce(v_bal, 0) + 1 where id = v_p;
  exception
    when check_violation then v_refused := true;
    when others then
      raise exception '0279: the proof update failed for the wrong reason: % %', sqlstate, sqlerrm;
  end;

  if not v_refused then
    raise exception '0279: a locked opening balance was CHANGED — the trigger does not hold';
  end if;

  -- and the way out works
  update public.partners set opening_balance_locked = false where id = v_p;
  update public.partners set opening_balance = coalesce(v_bal, 0) where id = v_p;

  -- restore the flag as found
  update public.partners set opening_balance_locked = v_was where id = v_p;

  raise notice '0279: lock proved to refuse when set and to permit when cleared';
end $$;