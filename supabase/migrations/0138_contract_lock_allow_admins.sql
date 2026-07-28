-- 0138: Let super-admins edit an Active contract's terms directly.
--
-- trg_contract_lock / enforce_contract_lock() locks an Active contract's original
-- terms so changes are made through dated addendums. The UI was later relaxed to let
-- holders of contracts.edit (super_admin / super_super_admin) edit an existing
-- contract directly, but this DB trigger was never updated to match — so a super-admin
-- editing an Active contract hit "contract is Active and its original terms are locked".
--
-- This aligns the trigger with that decision: super_admin and super_super_admin bypass
-- the lock (a direct, audited edit — the audit trigger still logs it); every other role
-- still must record a dated addendum. The app.contract_amendment escape hatch is kept.

create or replace function public.enforce_contract_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if old.status <> 'active' then
    return new;
  end if;

  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then
    return new;
  end if;

  -- Super-admins may edit an Active contract's terms directly.
  if exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('super_admin', 'super_super_admin')
  ) then
    return new;
  end if;

  if new.rate_per_guard_per_month is distinct from old.rate_per_guard_per_month
   or new.number_of_guards  is distinct from old.number_of_guards
   or new.day_guards        is distinct from old.day_guards
   or new.night_guards      is distinct from old.night_guards
   or new.evening_guards    is distinct from old.evening_guards
   or new.guard_rates       is distinct from old.guard_rates
   or new.start_date        is distinct from old.start_date
   or new.shift_pattern     is distinct from old.shift_pattern
   or new.eobi_amount       is distinct from old.eobi_amount
   or new.annual_escalation_pct is distinct from old.annual_escalation_pct then
    raise exception 'contract is Active and its original terms are locked; change it via a dated addendum'
      using errcode = '23514',
            hint = 'Record an addendum, or use amend_contract() for a logged correction.';
  end if;
  return new;
end;
$function$;
