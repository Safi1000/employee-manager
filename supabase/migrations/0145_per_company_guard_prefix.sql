-- 0145: Per-company permanent guard-code prefix (remove hardcoded 'GGS').
--
-- The permanent guard code's prefix now comes from each company's OWN configured
-- prefix instead of the constant 'GGS'. The prefix already exists as ONE field —
-- companies.invoice_settings->>'company_prefix' (used for invoice Ref numbers) —
-- so this unifies guard codes and invoices onto that single field. Nothing about
-- the code mechanism, immutability, or display layer changes; only the SOURCE of
-- the prefix value.
--
-- Existing permanent codes are IMMUTABLE and are NOT rewritten. Companies that
-- already hold 'GGS-' codes from the old hardcode (gng, DEMO CRM, SSG) keep them;
-- their going-forward prefix is a separate decision.

-- ---------------------------------------------------------------------------
-- 1. Uniqueness: no two companies may share the same prefix (case-insensitive).
--    Only enforced where a prefix is actually set (NULL/'' companies excluded).
--    Existing values (GGS, GSS) do not collide.
-- ---------------------------------------------------------------------------
create unique index if not exists companies_company_prefix_unique
  on public.companies (lower(nullif(trim(invoice_settings->>'company_prefix'), '')));

-- ---------------------------------------------------------------------------
-- 2. assign_guard_code(): allocate the next permanent code using the COMPANY's
--    configured prefix. Raises a clear error if the prefix is not set yet, so the
--    UI can prompt the admin instead of silently minting a wrong code. Everything
--    else (immutability, counter, history, employee_code mirror) is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.assign_guard_code(p_employee_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_client  uuid;
  v_existing text;
  v_prefix  text;
  v_n       bigint;
  v_code    text;
begin
  select company_id, client_id, guard_code
    into v_company, v_client, v_existing
  from public.employees where id = p_employee_id;

  if v_company is null then
    raise exception 'Employee % not found', p_employee_id;
  end if;
  if v_existing is not null then
    return v_existing;                       -- already assigned; immutable
  end if;

  -- Prefix comes from the company's own configuration (was hardcoded 'GGS').
  select nullif(trim(invoice_settings->>'company_prefix'), '')
    into v_prefix
  from public.companies where id = v_company;

  if v_prefix is null then
    raise exception 'Company prefix is not set. Set your Company Prefix in Invoice Structure settings before adding guards.'
      using errcode = 'check_violation';
  end if;

  v_n := public.next_counter(v_company, 'guard_code');
  v_code := upper(v_prefix) || '-' || lpad(v_n::text, 5, '0');

  update public.employees
     set guard_code = v_code, employee_code = v_code, updated_at = now()
   where id = p_employee_id;

  insert into public.employee_code_history
    (company_id, employee_id, old_code, new_code, client_id, reason, changed_by)
  values
    (v_company, p_employee_id, null, v_code, v_client, 'assigned', auth.uid());

  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Lock the prefix once the first permanent code is issued. Permanent codes are
--    immutable, so changing the prefix after codes exist would orphan real guard
--    IDs. Editable freely while the company has zero guard codes; read-only after.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_company_prefix_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text := nullif(trim(OLD.invoice_settings->>'company_prefix'), '');
  v_new text := nullif(trim(NEW.invoice_settings->>'company_prefix'), '');
begin
  -- Only care when the prefix value actually changes.
  if v_old is distinct from v_new then
    if v_old is not null
       and exists (select 1 from public.employees
                    where company_id = OLD.id and guard_code is not null) then
      raise exception 'Company prefix is locked: guards already have permanent codes under "%". It cannot be changed.', v_old
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_company_prefix_lock on public.companies;
create trigger trg_company_prefix_lock
  before update on public.companies
  for each row
  execute function public.enforce_company_prefix_lock();
