-- 0495 — Staff can request an expense, and approvers approve or reject it
--        with a note.
--
-- Asked for on 2026-10-05, DECIDED with the user:
--
--   * A new key, expenses.request, lets someone ask for an expense without
--     being able to see or edit the expense ledger. The requester writes what
--     it is for, how much, and a note.
--   * Anyone holding expenses.approve (the people who sign expenses off)
--     approves or rejects it. A rejection must carry a reply note; an approval
--     may.
--   * An approved request becomes a Pending expense. It is NOT inserted here:
--     recording an expense posts it to the books (journal_on_expense) and moves
--     a cash or bank balance (record_expense), so doing that at approval time
--     would spend money nobody has chosen a payment method for. Accounts record
--     it through the normal Add Expense path, prefilled from the request, and
--     link_expense_request() marks the request recorded and points it at the
--     expense. Only then does money move, exactly as for any other expense.
--
-- Single-row writes, each named by its id and asserted. Names are captured at
-- the moment of each action, because profiles are not readable across users.

-- ---------------------------------------------------------------------------
-- 1. The key.
-- ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label)
values ('expenses.request', 'Expenses', 'Request an expense (for approval)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------------
create table if not exists public.expense_requests (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  category_id        uuid references public.expense_categories(id) on delete set null,
  client_id          uuid references public.clients(id) on delete set null,
  amount             numeric not null check (amount > 0),
  needed_by          date,
  description        text not null check (length(btrim(description)) between 1 and 500),
  note               text check (note is null or length(note) <= 4000),
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'rejected', 'recorded')),
  requested_by       uuid references public.profiles(id),
  requested_by_name  text,
  requested_at       timestamptz not null default now(),
  decided_by         uuid references public.profiles(id),
  decided_by_name    text,
  decided_at         timestamptz,
  decision_note      text check (decision_note is null or length(decision_note) <= 4000),
  expense_id         uuid references public.expenses(id) on delete set null,
  updated_at         timestamptz not null default now(),
  check (status <> 'rejected' or coalesce(btrim(decision_note), '') <> ''),
  check ((status = 'pending') = (decided_at is null)),
  check (status <> 'recorded' or expense_id is not null)
);

create index if not exists expense_requests_company_status
  on public.expense_requests (company_id, status, requested_at desc);

comment on table public.expense_requests is
  'Requests for an expense, made under expenses.request and approved or rejected under expenses.approve (0495). An approved request is recorded as an ordinary expense through record_expense and linked back by link_expense_request; nothing here moves money. Written only by the RPCs.';

alter table public.expense_requests enable row level security;

-- Readable within the company by anyone who works with expenses, and by the
-- requester for their own.
drop policy if exists er_read on public.expense_requests;
create policy er_read on public.expense_requests
  for select using (
    company_id = (select public.current_company_id())
    and (
      requested_by = (select auth.uid())
      or (select public.has_perm('expenses.view'))
      or (select public.has_perm('expenses.edit'))
      or (select public.has_perm('expenses.approve'))
    )
  );
drop policy if exists er_ssa on public.expense_requests;
create policy er_ssa on public.expense_requests
  for select using ((select public.is_ssa_unscoped()));

-- ---------------------------------------------------------------------------
-- 3. Make a request.
-- ---------------------------------------------------------------------------
create or replace function public.request_expense(
  p_category_id uuid, p_client_id uuid, p_amount numeric, p_description text,
  p_note text default null, p_needed_by date default null)
returns public.expense_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid; v_row public.expense_requests; v_name text;
begin
  perform public.require_perm('expenses.request');
  if p_category_id is not null then
    perform public.assert_same_company((select company_id from public.expense_categories where id = p_category_id));
  end if;
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  v_company := public.current_company_id();
  if v_company is null then raise exception 'No company is selected.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;
  if coalesce(btrim(p_description), '') = '' then raise exception 'Say what the expense is for.'; end if;

  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();

  insert into public.expense_requests
    (company_id, category_id, client_id, amount, needed_by, description, note, requested_by, requested_by_name)
  values (v_company, p_category_id, p_client_id, round(p_amount, 2), p_needed_by, btrim(p_description),
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), v_name)
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Approve or reject.
-- ---------------------------------------------------------------------------
create or replace function public.decide_expense_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns public.expense_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.expense_requests; v_name text; v_n int;
begin
  perform public.require_perm('expenses.approve');
  perform public.assert_same_company((select company_id from public.expense_requests where id = p_request_id));

  select * into v_row from public.expense_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'Request not found.'; end if;
  if v_row.status <> 'pending' then
    raise exception 'This request has already been %.', v_row.status;
  end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then
    raise exception 'Add a note saying why it is rejected.';
  end if;

  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();

  update public.expense_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_by_name = v_name, decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = p_request_id and status = 'pending'
  returning * into v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The request changed while you were deciding it. Reload and try again.'; end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Link the recorded expense back to the request.
-- ---------------------------------------------------------------------------
create or replace function public.link_expense_request(p_request_id uuid, p_expense_id uuid)
returns public.expense_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.expense_requests; v_n int;
begin
  perform public.require_perm('expenses.edit');
  perform public.assert_same_company((select company_id from public.expense_requests where id = p_request_id));
  perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
  if not exists (select 1 from public.expenses where id = p_expense_id) then
    raise exception 'Expense not found.';
  end if;
  update public.expense_requests
     set status = 'recorded', expense_id = p_expense_id, updated_at = now()
   where id = p_request_id and status = 'approved'
  returning * into v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Only an approved request can be recorded, and only once.'; end if;
  return v_row;
end;
$$;

revoke all on function public.request_expense(uuid, uuid, numeric, text, text, date) from public;
revoke all on function public.decide_expense_request(uuid, boolean, text) from public;
revoke all on function public.link_expense_request(uuid, uuid) from public;
grant execute on function public.request_expense(uuid, uuid, numeric, text, text, date) to authenticated;
grant execute on function public.decide_expense_request(uuid, boolean, text) to authenticated;
grant execute on function public.link_expense_request(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Checks.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.permission_key_gaps()) then
    raise exception '0495 FAILED: permission_key_gaps() is not empty.';
  end if;
end $$;

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
