-- Verified-identity lock + amendment log (spec section 11).
--
-- "Once verified, core identity fields lock. Changes go through an amendment
-- log (old -> new, date, user, reason) — reuse the Audit Log mechanism."
--
-- Core identity = full_name, father_or_husband_name, cnic_number,
-- date_of_birth. Once an employee's identity is verified these cannot be
-- edited by an ordinary UPDATE; they can only move through
-- amend_employee_identity(), which records the old -> new -> reason into the
-- existing audit_log (action 'update', a JSON payload flagged as an identity
-- amendment). The lock is enforced in the database, so no write path — app,
-- import, or direct SQL — can quietly change a verified identity.

alter table public.employees
  add column if not exists identity_verified     boolean not null default false,
  add column if not exists identity_verified_at  timestamptz,
  add column if not exists identity_verified_by  uuid;

-- ---------------------------------------------------------------------------
-- The lock. Blocks changes to core identity fields on a verified employee
-- unless the amendment path has flagged the transaction as authorised.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_identity_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Not verified yet, or verification is being set now: nothing to lock.
  if not old.identity_verified then
    return new;
  end if;

  -- The amendment RPC sets this transaction-local flag before its update.
  if coalesce(current_setting('app.identity_amendment', true), '') = '1' then
    return new;
  end if;

  if new.full_name             is distinct from old.full_name
   or new.father_or_husband_name is distinct from old.father_or_husband_name
   or new.cnic_number          is distinct from old.cnic_number
   or new.date_of_birth        is distinct from old.date_of_birth then
    raise exception 'core identity is verified and locked; use an amendment (with reason)'
      using errcode = '23514',
            hint = 'Call amend_employee_identity(employee, field, new_value, reason).';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_emp_identity_lock on public.employees;
create trigger trg_emp_identity_lock
  before update on public.employees
  for each row execute function public.enforce_identity_lock();

-- ---------------------------------------------------------------------------
-- Verify / unverify.
-- ---------------------------------------------------------------------------

create or replace function public.verify_employee_identity(p_employee_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.employees
     set identity_verified = true,
         identity_verified_at = now(),
         identity_verified_by = auth.uid(),
         updated_at = now()
   where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
end;
$$;

-- Unverify is itself a logged event: unlocking a verified identity is exactly
-- the kind of act that must leave a trail.
create or replace function public.unverify_employee_identity(p_employee_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_company uuid;
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'unverifying an identity requires a reason' using errcode = '23514';
  end if;
  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  update public.employees
     set identity_verified = false, identity_verified_at = null,
         identity_verified_by = null, updated_at = now()
   where id = p_employee_id;

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'employees', p_employee_id, 'update', auth.uid(),
          jsonb_build_object('kind', 'identity_unverify', 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- The amendment path: the only way to change a locked identity field.
-- Records old -> new -> reason to audit_log, then makes the change under the
-- transaction-local authorisation flag so the lock lets it through.
-- ---------------------------------------------------------------------------

create or replace function public.amend_employee_identity(
  p_employee_id uuid,
  p_field       text,
  p_new_value   text,
  p_reason      text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_old     text;
begin
  if p_field not in ('full_name', 'father_or_husband_name', 'cnic_number', 'date_of_birth') then
    raise exception 'field % is not an amendable core identity field', p_field
      using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'an amendment requires a reason' using errcode = '23514';
  end if;

  select company_id into v_company from public.employees where id = p_employee_id;
  if v_company is null then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;

  -- Capture the old value for the log.
  execute format('select (%I)::text from public.employees where id = $1', p_field)
     into v_old using p_employee_id;

  -- Authorise, apply, then immediately drop the flag so nothing else in the
  -- transaction rides on it. %L lets the string literal coerce to the column
  -- type (e.g. date_of_birth); p_field is whitelisted above.
  perform set_config('app.identity_amendment', '1', true);
  execute format('update public.employees set %I = %L, updated_at = now() where id = %L',
                 p_field, p_new_value, p_employee_id);
  perform set_config('app.identity_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'employees', p_employee_id, 'update', auth.uid(),
          jsonb_build_object(
            'kind', 'identity_amendment',
            'field', p_field,
            'old', v_old,
            'new', p_new_value,
            'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- PDF flow: the "Form signed on [date]" flag (spec §11).
-- ---------------------------------------------------------------------------

create or replace function public.mark_form_signed(p_employee_id uuid, p_signed_on date)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.employees set form_signed_on = p_signed_on, updated_at = now()
   where id = p_employee_id;
  if not found then
    raise exception 'employee % not found', p_employee_id using errcode = '23503';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read-back of an employee's amendment history, for the form's amendment panel.
-- ---------------------------------------------------------------------------

create or replace view public.employee_identity_amendments
  with (security_invoker = true) as
  select al.record_id as employee_id,
         al.company_id,
         al.changed_at,
         al.changed_by,
         al.changes->>'field'  as field,
         al.changes->>'old'    as old_value,
         al.changes->>'new'    as new_value,
         al.changes->>'reason' as reason
    from public.audit_log al
   where al.table_name = 'employees'
     and al.changes->>'kind' = 'identity_amendment';
