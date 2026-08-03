-- 0161: remove the Ops-verify / Finance-approve workflow.
--
-- record_state gated real work: a draft guard could not be moved between clients
-- or have their shift changed, and payroll silently skipped anyone below
-- finance_approved — withholding pay from people who had genuinely worked. The
-- workflow is gone from the UI, so the gates must go with it, or those actions
-- would fail with an error nobody can now clear.
--
-- The column stays (audit history and existing rows reference it); it simply
-- stops blocking anything.

drop trigger if exists trg_enforce_posting_requires_ops_verified on public.employees;

create or replace function public.enforce_posting_requires_ops_verified()
returns trigger language plpgsql as $$
begin
  -- Retained as a no-op so any lingering trigger definition is harmless.
  return NEW;
end $$;

create or replace function public.change_client(
  p_guard_id         uuid,
  p_new_client_id    uuid,
  p_contract_line_id uuid default null,
  p_site_id          uuid default null,
  p_reason           deployment_reason default 'relief_cover',
  p_effective_date   date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_company uuid; v_eff date; v_site uuid; v_start date; v_new_id uuid;
begin
  select company_id into v_company from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Guard % not found', p_guard_id; end if;

  v_eff  := coalesce(p_effective_date, current_date);
  v_site := coalesce(p_site_id,
    (select id from public.sites where client_id = p_new_client_id and is_default limit 1));

  select start_date into v_start from public.deployments
    where guard_id = p_guard_id and end_date is null;
  update public.deployments
     set end_date = greatest(coalesce(v_start, v_eff - 1), v_eff - 1), updated_at = now()
   where guard_id = p_guard_id and end_date is null;

  insert into public.deployments
    (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
  values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, p_reason)
  returning id into v_new_id;

  return v_new_id;
end $$;

create or replace function public.change_category(
  p_guard_id uuid,
  p_new_category text,
  p_new_client_id uuid default null,
  p_contract_line_id uuid default null,
  p_effective_date date default null
) returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  v_company uuid; v_eff date; v_site uuid; v_start date;
begin
  if p_new_category not in ('client','office_staff','reliever') then
    raise exception 'Invalid category %', p_new_category;
  end if;
  select company_id into v_company from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Employee % not found', p_guard_id; end if;

  v_eff := coalesce(p_effective_date, current_date);

  select start_date into v_start from public.deployments
    where guard_id = p_guard_id and end_date is null;
  update public.deployments
     set end_date = greatest(coalesce(v_start, v_eff - 1), v_eff - 1), updated_at = now()
   where guard_id = p_guard_id and end_date is null;

  if p_new_category = 'client' then
    if p_new_client_id is null then
      raise exception 'Select a client to move this employee to';
    end if;
    v_site := (select id from public.sites where client_id = p_new_client_id and is_default limit 1);
    insert into public.deployments
      (company_id, guard_id, client_id, contract_line_id, site_id, start_date, reason)
    values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, 'new_hire');
    update public.employees
       set category = 'client',
           contract_line_id = p_contract_line_id,
           contract_id = (select contract_id from public.contract_lines where id = p_contract_line_id),
           updated_at = now()
     where id = p_guard_id;
  else
    update public.employees
       set category = p_new_category,
           contract_id = null, contract_line_id = null,
           assignment_effective_from = null, assignment_effective_to = null,
           updated_at = now()
     where id = p_guard_id;
  end if;
end $$;
