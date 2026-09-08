-- 0410 — catalogue the new "View Assignment & Pay" key.
--
-- assignments.view gates whether the Assignments & Pay page is shown at all;
-- assignments.accounts / assignments.hr (0343) then gate editing inside it. The
-- key is enforced in the frontend route guard, not by any DB policy, so it is not
-- "demanded" and permission_key_gaps() would not flag it — but permission_keys
-- mirrors PERMISSION_GROUPS, so it belongs here for the grant screen and audit.
insert into public.permission_keys (key, grp, label) values
  ('assignments.view', 'Assignments & Pay', 'View the Assignments & Pay page (Accounts/HR gate editing)')
on conflict (key) do nothing;

-- No authenticated-executable SECURITY DEFINER function with a tenant uuid
-- parameter is added, so no gap; assert the detector still reads clean.
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception 'REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
