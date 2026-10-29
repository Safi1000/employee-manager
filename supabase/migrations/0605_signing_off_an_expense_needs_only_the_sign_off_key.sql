-- 0605 — signing off an expense needs only the sign-off key
--
-- Shayan, 29 Oct 2026: "i gave CEO the option to sign off any expense but for
-- some reason he cant". The CEO holds expenses.approve and not expenses.edit.
-- The screen signed off by UPDATE-ing expenses directly, and expenses'
-- perm_write_upd policy asks expenses.edit — so his sign-offs touched zero
-- rows and the screen said "could not be signed off".
--
-- Granting him expenses.edit would be the wrong fix. Signing off is the second
-- person's step on a record the first person wrote: the key follows the STAGE,
-- not the table (CLAUDE.md, the transition_record_state exception). One key
-- would let one person write an expense and sign off their own figure.
--
--   public.sign_off_expenses(p_ids uuid[], p_approve boolean) → integer
--     expenses.approve only. Signs off (or undoes the sign-off of) exactly the
--     expenses named.
--
-- SECURITY DEFINER, deliberately: under INVOKER the table's perm_write_upd
-- would add expenses.edit back on top and re-flatten the split (the cascade
-- case, 0375/0385). And because this is a SET write, it asserts the boundary
-- inside rather than letting RLS make the result silently smaller:
--   * each expense is locked and checked — same company (assert_same_company)
--     and the caller's region (assert_branch_writable on the expense's branch,
--     else its client's) — the same reach branch_scope gives a direct write;
--   * an expense already in the asked-for state refuses the WHOLE call, naming
--     it, rather than signing off a smaller set and reporting success;
--   * the row count is asserted against the ids given.
-- The approval lock trigger still runs: undoing a sign-off stamps unapproved_*
-- and touches nothing else, exactly as before.
--
-- Asserted: as the CEO, an unsigned expense is signed off and then undone, the
-- approver stamped as the CEO; the HR login (expenses.edit, no sign-off key) is
-- refused with the exact message; signing off an already-signed expense is
-- refused; no security, tenant or branch gap (rolled back by a sentinel whose
-- message is checked).

create or replace function public.sign_off_expenses(p_ids uuid[], p_approve boolean)
returns integer
language plpgsql
security definer
set search_path = public
as $$
  -- 0605. Sign off / undo the sign-off of exactly these expenses.
  declare
    v_ids uuid[] := (select array_agg(distinct x) from unnest(coalesce(p_ids, '{}')) x where x is not null);
    r record; v_wrong text; n int;
  begin
    perform public.require_perm('expenses.approve');
    if coalesce(cardinality(v_ids), 0) = 0 then raise exception 'Choose at least one expense.'; end if;

    -- tenant guard [resolved]: each expense's company and region checked below.
    for r in
      select e.id, e.company_id, e.approved_at, e.amount, e.expense_date, coalesce(e.branch_id, c.branch_id) region
        from public.expenses e left join public.clients c on c.id = e.client_id
       where e.id = any (v_ids)
       for update of e
    loop
      perform public.assert_same_company(r.company_id);
      perform public.assert_branch_writable(r.region);
      if p_approve = (r.approved_at is not null) then
        v_wrong := concat_ws('; ', v_wrong, to_char(r.expense_date, 'DD Mon') || ' PKR ' || to_char(r.amount, 'FM999,999,999'));
      end if;
    end loop;
    if (select count(*) from public.expenses where id = any (v_ids)) <> cardinality(v_ids) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    if v_wrong is not null then
      raise exception '%: %. Nothing was changed — reload and try again.',
        case when p_approve then 'Already signed off' else 'Not signed off' end, v_wrong;
    end if;

    if p_approve then
      update public.expenses set approved_at = now(), approved_by = auth.uid()
       where id = any (v_ids) and approved_at is null;
    else
      update public.expenses set approved_at = null
       where id = any (v_ids) and approved_at is not null;
    end if;
    get diagnostics n = row_count;
    if n <> cardinality(v_ids) then
      raise exception 'Only % of % expenses changed. Nothing was changed — reload and try again.', n, cardinality(v_ids);
    end if;
    return n;
  end $$;
comment on function public.sign_off_expenses(uuid[], boolean) is
  '0605: sign off / undo sign-off of the named expenses. expenses.approve ONLY — the stage key, never expenses.edit (separation of duties). DEFINER because invoker would add perm_write_upd''s expenses.edit back; company and region asserted per row, whole call refused on any mismatch, row count asserted.';
revoke all on function public.sign_off_expenses(uuid[], boolean) from public, anon;
grant execute on function public.sign_off_expenses(uuid[], boolean) to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('sign_off_expenses', '{expenses.approve}', 'Expenses › Sign off (0605)')
on conflict (function_name) do nothing;

do $test$
declare
  v_ceo constant uuid := (select id from public.profiles where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and title = 'CEO' and disabled_at is null limit 1);
  v_hr  constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_exp uuid := (select id from public.expenses where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and approved_at is null order by created_at desc limit 1);
  v_msg text; v_by uuid;
begin
  if v_ceo is null or v_exp is null then raise exception '0605 REFUSED: no CEO login or no unsigned expense to test with.'; end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    if public.sign_off_expenses(array[v_exp], true) <> 1 then raise exception '0605 REFUSED: the CEO could not sign off one expense.'; end if;
    select approved_by into v_by from public.expenses where id = v_exp;
    if v_by is distinct from v_ceo then raise exception '0605 REFUSED: approved_by is %, not the CEO.', v_by; end if;

    v_msg := null;
    begin perform public.sign_off_expenses(array[v_exp], true); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or v_msg not like 'Already signed off:%' then raise exception '0605 REFUSED: a second sign-off said "%".', v_msg; end if;

    if public.sign_off_expenses(array[v_exp], false) <> 1 then raise exception '0605 REFUSED: the CEO could not undo the sign-off.'; end if;
    if (select approved_at from public.expenses where id = v_exp) is not null then raise exception '0605 REFUSED: undo left it signed off.'; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null;
    begin perform public.sign_off_expenses(array[v_exp], true); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'permission denied: expenses.approve required' then raise exception '0605 REFUSED: HR said "%".', v_msg; end if;
    raise exception '0605-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0605-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0605 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0605 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name = 'sign_off_expenses') then raise exception '0605 REFUSED: branch_guard_gaps() reports sign_off_expenses.'; end if;
end $test$;
