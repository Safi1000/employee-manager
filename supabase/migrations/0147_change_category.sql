-- 0147: change_category — move an employee between reliever / client / office_staff,
-- preserving history via dated postings (mirrors change_client).
--
-- → client: requires Ops-verified + a client; closes any open posting at eff-1 and
--   opens a new deployment from the effective date (sync trigger sets client_id).
-- → office_staff / reliever: closes any open posting at eff-1 (sync trigger nulls
--   client_id + display_number) and clears the client mirrors.
-- Past dated rows are never edited, so prior attendance stays under the old posting
-- and the new state applies from the effective date. The permanent guard code is
-- untouched; only the client-prefixed display code drops when leaving a client.
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

  -- Close any open posting the day before the change; past attendance stays put.
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
     where id = p_guard_id;   -- sync trigger sets client_id from the new deployment
  else
    update public.employees
       set category = p_new_category,
           contract_id = null, contract_line_id = null,
           assignment_effective_from = null, assignment_effective_to = null,
           updated_at = now()
     where id = p_guard_id;   -- sync trigger already nulled client_id/display_number
  end if;
end $$;

grant execute on function public.change_category(uuid,text,uuid,uuid,date) to authenticated;
