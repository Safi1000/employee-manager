-- 0184: change_category — cast the text param to the enum when moving a guard to
-- office_staff / reliever.
--
-- employees.category is the enum employee_category. The 'client' branch assigns
-- the string literal 'client', which coerces fine, but the else branch assigned
-- the text VARIABLE p_new_category directly — and Postgres will not implicitly
-- cast a text variable to an enum in an assignment, so every move to Office Staff
-- or Reliever failed with:
--   column "category" is of type employee_category but expression is of type text
--
-- Only that one assignment changes; the rest is 0182 verbatim.
create or replace function public.change_category(
  p_guard_id uuid,
  p_new_category text,
  p_new_client_id uuid default null,
  p_contract_line_id uuid default null,
  p_effective_date date default null,
  p_site_id uuid default null
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
    v_site := coalesce(
      p_site_id,
      (select id from public.sites where client_id = p_new_client_id and is_default limit 1)
    );
    if p_site_id is not null and not exists (
      select 1 from public.sites where id = p_site_id and client_id = p_new_client_id
    ) then
      raise exception 'Site % does not belong to client %', p_site_id, p_new_client_id;
    end if;
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

grant execute on function public.change_category(uuid,text,uuid,uuid,date,uuid) to authenticated;
