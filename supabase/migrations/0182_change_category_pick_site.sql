-- 0182: change_category — let a client transfer choose the SITE, instead of always
-- landing the guard on the client's default site.
--
-- The transfer modal now offers the target client's sites and filters contract
-- lines to the chosen site. Backend-side, change_category gains p_site_id: when
-- given it is used verbatim; when null it falls back to the default site, i.e.
-- exactly the previous behaviour, so every existing 5-arg caller is unaffected.
--
-- Based on the LIVE function (the draft/Ops-verify gate was already dropped by
-- 0161); only the site selection changes.
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
    -- Chosen site wins; otherwise the client's default site (previous behaviour).
    v_site := coalesce(
      p_site_id,
      (select id from public.sites where client_id = p_new_client_id and is_default limit 1)
    );
    -- A passed site must belong to the target client — guards against a stale id.
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
       set category = p_new_category,
           contract_id = null, contract_line_id = null,
           assignment_effective_from = null, assignment_effective_to = null,
           updated_at = now()
     where id = p_guard_id;
  end if;
end $$;

grant execute on function public.change_category(uuid,text,uuid,uuid,date,uuid) to authenticated;

-- CREATE OR REPLACE with the extra arg makes a new overload rather than replacing,
-- so drop the old 5-arg version — otherwise a 5-arg call is ambiguous (the 6-arg
-- one also matches via its default) and errors. 5-arg callers now resolve to the
-- new function with p_site_id defaulting to null = the previous default-site path.
drop function if exists public.change_category(uuid,text,uuid,uuid,date);
