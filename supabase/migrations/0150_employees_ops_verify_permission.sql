-- 0150: Allow Ops-verify by a fine-grained permission, not only by role.
--
-- Until now transition_record_state() gated the 'ops_verify' action to the
-- roles ops_manager / ops_director / super_admin / super_super_admin (0122).
-- This adds an ALTERNATIVE grant: any user holding the new 'employees.ops_verify'
-- permission (profiles.permissions) may also Ops-verify, WITHOUT changing their
-- role. Uses the shared has_perm() predicate (0101), which already returns true
-- for super_admin/SSA — so their behaviour is unchanged. Only the ops_verify
-- branch changes; finance_approve and reverse gates are identical to 0122.
create or replace function public.transition_record_state(
  p_employee_id uuid,
  p_action      text,               -- 'ops_verify' | 'finance_approve' | 'reverse'
  p_reason      text default null
) returns record_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_company uuid;
  v_cur     record_state;
  v_new     record_state;
begin
  select role::text into v_role from public.profiles where id = auth.uid();
  select company_id, record_state into v_company, v_cur
    from public.employees where id = p_employee_id;
  if v_company is null then raise exception 'Employee % not found', p_employee_id; end if;

  if p_action = 'ops_verify' then
    if v_cur <> 'draft' then raise exception 'Can only Ops-verify a Draft record (current: %)', v_cur; end if;
    -- Role-based grant OR the explicit 'employees.ops_verify' permission.
    if not (
         v_role in ('ops_manager','ops_director','super_admin','super_super_admin')
         or public.has_perm('employees.ops_verify')
       ) then
      raise exception 'Not authorised to Ops-verify (needs an Ops role or the Ops-verify permission)'; end if;
    v_new := 'ops_verified';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'ops_verify', p_reason, auth.uid());

  elsif p_action = 'finance_approve' then
    if v_cur <> 'ops_verified' then raise exception 'Can only Finance-approve an Ops-verified record (current: %)', v_cur; end if;
    if v_role not in ('finance_director','super_admin','super_super_admin') then
      raise exception 'Only Director Finance may approve'; end if;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, 'finance_approved', 'finance_approve', p_reason, auth.uid());
    v_new := 'active';
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, 'finance_approved', v_new, 'activate', 'auto (system) on finance approval', auth.uid());

  elsif p_action = 'reverse' then
    if p_reason is null or btrim(p_reason) = '' then raise exception 'Reversal requires a reason'; end if;
    if v_cur = 'active' or v_cur = 'finance_approved' then
      if v_role not in ('finance_director','super_admin','super_super_admin') then
        raise exception 'Only Director Finance or super admin may reverse a finance-approved/active record'; end if;
      v_new := 'ops_verified';
    elsif v_cur = 'ops_verified' then
      if v_role not in ('ops_manager','ops_director','super_admin','super_super_admin') then
        raise exception 'Only Ops Manager/Director or super admin may reverse an Ops-verified record'; end if;
      v_new := 'draft';
    else
      raise exception 'Nothing to reverse from Draft';
    end if;
    update public.employees set record_state = v_new, updated_at = now() where id = p_employee_id;
    insert into public.employee_approval_events(company_id, employee_id, from_state, to_state, action, reason, approved_by)
      values (v_company, p_employee_id, v_cur, v_new, 'reverse', p_reason, auth.uid());
  else
    raise exception 'Unknown action %', p_action;
  end if;

  return v_new;
end;
$$;

grant execute on function public.transition_record_state(uuid, text, text) to authenticated;
