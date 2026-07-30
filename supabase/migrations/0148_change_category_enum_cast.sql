-- 0148: Fix change_category — cast the text parameter to the employee_category
-- enum. employees.category is of type employee_category, so assigning the plain
-- text p_new_category raised "column category is of type employee_category but
-- expression is of type text". Only the non-client UPDATE needs the cast (the
-- client branch assigns the literal 'client', which casts implicitly). Behaviour
-- is otherwise identical to 0147.
create or replace function public.change_category(
  p_guard_id uuid,
  p_new_category text,
  p_new_client_id uuid default null,
  p_contract_line_id uuid default null,
  p_effective_date date default null
) returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  v_company uuid; v_state record_state; v_eff date; v_site uuid; v_start date;
begin
  if p_new_category not in ('client','office_staff','reliever') then
    raise exception 'Invalid category %', p_new_category;
  end if;
  select company_id, record_state into v_company, v_state
    from public.employees where id = p_guard_id;
  if v_company is null then raise exception 'Employee % not found', p_guard_id; end if;

  v_eff := coalesce(p_effective_date, current_date);

  select start_date into v_start from public.deployments
    where guard_id = p_guard_id and end_date is null;
  update public.deployments
     set end_date = greatest(coalesce(v_start, v_eff - 1), v_eff - 1), updated_at = now()
   where guard_id = p_guard_id and end_date is null;

  if p_new_category = 'client' then
    if v_state = 'draft' then
      raise exception 'Employee must be Ops-verified before being posted to a client';
    end if;
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
       set category = p_new_category::public.employee_category,
           contract_id = null, contract_line_id = null,
           assignment_effective_from = null, assignment_effective_to = null,
           updated_at = now()
     where id = p_guard_id;
  end if;
end $$;

grant execute on function public.change_category(uuid,text,uuid,uuid,date) to authenticated;
