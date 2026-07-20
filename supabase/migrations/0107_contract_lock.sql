-- Contract Lock (spec section 23).
--
-- The addendum model (dated changes to contract_lines) already exists and is
-- correct — keep it. This TIGHTENS the baseline: once a contract is Active, its
-- ORIGINAL commercial terms on the contracts row lock. No silent edits; a
-- genuine correction goes through amend_contract() (logged, with a reason, the
-- same mechanism §11 uses for verified identities), and every ongoing change
-- flows through dated addendums. The amendment history is exposed as one
-- timeline on the contract.
--
-- Only Part VII's §23 is new work; §24 (keep existing), §25 (dependency spine),
-- §26 (decisions D1–D7, already applied as editable defaults) and §27 (SOP
-- register) are documentation over modules already built.

-- ===========================================================================
-- 1. The lock: freeze original commercial terms on an Active contract.
-- ===========================================================================

create or replace function public.enforce_contract_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only Active contracts are locked; drafts are freely editable, and moving a
  -- contract INTO active (draft -> active) sets the baseline, not a violation.
  if old.status <> 'active' then
    return new;
  end if;

  -- The amendment path flags the transaction as authorised.
  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then
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
$$;

drop trigger if exists trg_contract_lock on public.contracts;
create trigger trg_contract_lock
  before update on public.contracts
  for each row execute function public.enforce_contract_lock();

-- ===========================================================================
-- 2. The blessed correction path: logged, with a reason, to the audit log.
-- ===========================================================================

create or replace function public.amend_contract(
  p_contract_id uuid, p_field text, p_new_value text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid; v_old text;
begin
  if p_field not in ('rate_per_guard_per_month','number_of_guards','day_guards',
                     'night_guards','evening_guards','start_date','shift_pattern',
                     'eobi_amount','annual_escalation_pct') then
    raise exception 'field % is not an amendable contract term', p_field using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a contract amendment requires a reason' using errcode = '23514';
  end if;

  select company_id into v_company from public.contracts where id = p_contract_id;
  if v_company is null then
    raise exception 'contract % not found', p_contract_id using errcode = '23503';
  end if;

  execute format('select (%I)::text from public.contracts where id = $1', p_field)
     into v_old using p_contract_id;

  perform set_config('app.contract_amendment', '1', true);
  execute format('update public.contracts set %I = %L, updated_at = now() where id = %L',
                 p_field, p_new_value, p_contract_id);
  perform set_config('app.contract_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'contracts', p_contract_id, 'update', auth.uid(),
          jsonb_build_object('kind','contract_amendment','field',p_field,
                             'old',v_old,'new',p_new_value,'reason',p_reason));
end;
$$;

-- ===========================================================================
-- 3. The amendment history timeline: dated addendums (ongoing changes) plus
--    any logged baseline corrections, newest first.
-- ===========================================================================

create or replace view public.contract_amendment_history
  with (security_invoker = true) as
  -- Dated addendums (the normal ongoing-change path)
  select ad.contract_id,
         ad.company_id,
         ad.effective_from        as event_date,
         'addendum'::text         as kind,
         (coalesce(ad.change_type::text,'change')
           || coalesce(' · ' || ad.category::text, '')
           || coalesce(' · Δ' || ad.count_delta, '')
           || coalesce(' · rate ' || ad.new_rate, '')) as detail,
         ad.reference             as reference,
         ad.created_at
    from public.contract_addendums ad
  union all
  -- Logged baseline corrections via amend_contract
  select al.record_id,
         al.company_id,
         al.changed_at::date,
         'baseline_correction',
         (al.changes->>'field' || ': ' || coalesce(al.changes->>'old','—')
           || ' → ' || coalesce(al.changes->>'new','—')
           || ' (' || coalesce(al.changes->>'reason','') || ')'),
         null,
         al.changed_at
    from public.audit_log al
   where al.table_name = 'contracts'
     and al.changes->>'kind' = 'contract_amendment';
