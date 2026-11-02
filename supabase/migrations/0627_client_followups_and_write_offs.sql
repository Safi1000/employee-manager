-- 0627 — chasing late payers, and writing off a bad debt per client.
--
-- DECIDED by Shayan, 2 Nov 2026 (the old Receivables page, asked and answered):
--   * One place for receivables: Invoices → Receivables. The separate page
--     (Receivables.tsx — regional aging, reminder cadence, write-offs, attendance
--     billing, policy) is removed. It was already unreachable (its route forwards
--     to Invoices → Receivables) and nothing on it had ever been used: 0 reminders,
--     0 write-offs, 0 clients flagged.
--   * Follow-ups are logged PER CLIENT: who was contacted, how (call, WhatsApp,
--     letter, visit, email), what they said, any promise (amount and date), and
--     when to follow up again.
--   * A bad debt is written off PER CLIENT, from the client's ledger: amount and
--     reason, and a SECOND PERSON approves. Requesting needs invoices.edit;
--     approving needs receivables.write_off_approve, and the approver may not be
--     the requester (the stage rule in CLAUDE.md: one key would let one person do
--     both halves of a two-person act).
--   * Attendance billing as a separate calculator is gone: Invoices → Generate
--     already bills from attendance.
--
-- WHY THE OLD write_off_receivable IS WITHDRAWN. It posted Dr bad debt / Cr AR for
-- an invoice's outstanding but left the invoice's amount_received alone and only
-- set status 'Written-Off' — so the client's balance on every screen still
-- counted it, and ar_control's subledger dropped the WHOLE invoice (receipts
-- still subtracted) where the ledger credited only the outstanding: a partly paid
-- invoice written off would have opened a gap of exactly what had been received.
-- It was never used. Its execute grant is revoked so the per-client path is the
-- only one; the function stays for reverse_write_off's sake and for the record.
--
-- WHAT A WRITE-OFF DOES. Approved: Dr bad debt, Cr receivables (1100), in the
-- region finance_settings.bad_debt_bearer names (the same rule as before). The
-- client's balance falls by the amount: client_receivables_today and
-- client_receivable_ledger count approved write-offs alongside receipts, oldest
-- first. ar_control_equals_open_invoices's subledger subtracts them (surgery on
-- ledger_checks_base below), so the check stays exactly where it was.
--
-- RESTATED, NOT AMENDED: client_receivables_today and client_receivable_ledger
-- have one author (0626) and are restated here behind a digest of the body they
-- replace. Their return types change (new columns), so each is dropped and
-- recreated. ledger_checks_base has many authors and is amended by surgery.

-- ───────────────────────── 0. Preconditions ─────────────────────────
do $pre$
begin
  if md5(pg_get_functiondef('public.client_receivables_today()'::regprocedure)) <> 'e5b39cb00f991e65574d1c788f874826' then
    raise exception '0627 REFUSED: client_receivables_today is not the body 0626 wrote — someone edited it since. Amend by surgery instead.';
  end if;
  if md5(pg_get_functiondef('public.client_receivable_ledger(uuid,date,date)'::regprocedure)) <> '20a5e2ef3bf937cb5a632854ee6dfe6e' then
    raise exception '0627 REFUSED: client_receivable_ledger is not the body 0626 wrote — someone edited it since. Amend by surgery instead.';
  end if;
  if exists (select 1 from public.invoices where status = 'Written-Off') then
    raise exception '0627 REFUSED: an invoice has been written off the old way; this migration assumes none has.';
  end if;
end $pre$;

-- ───────────────────────── 1. Follow-ups ─────────────────────────
create table if not exists public.client_followups (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  client_id       uuid not null references public.clients(id),
  contacted_on    date not null default current_date,
  channel         text not null check (channel in ('call', 'whatsapp', 'letter', 'visit', 'email')),
  note            text not null check (length(btrim(note)) > 0),
  promised_amount numeric(14,2) check (promised_amount is null or promised_amount > 0),
  promised_by     date,
  next_follow_up  date,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now()
);
create index if not exists client_followups_client_idx on public.client_followups (client_id, contacted_on desc, created_at desc);

comment on table public.client_followups is
  'DECIDED 2 Nov 2026 (0627): one row per contact with a client about money they owe — channel, what was said, an optional promise (amount and date) and when to follow up again. A promise is a note, not a receivable: it moves no balance. Written only by log_client_followup().';

alter table public.client_followups enable row level security;
create policy company_members on public.client_followups for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.client_followups for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.client_followups as restrictive for select
  using ((select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit'))
      or (select public.has_perm('receivables.view')) or (select public.has_perm('accounting.edit')));
create policy perm_write_ins on public.client_followups as restrictive for insert with check (false);
create policy perm_write_upd on public.client_followups as restrictive for update using (false) with check (false);
create policy perm_write_del on public.client_followups as restrictive for delete using (false);
create policy branch_scope on public.client_followups as restrictive for all
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = client_followups.client_id and c.branch_id = (select public.current_branch_id())))
  with check ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = client_followups.client_id and c.branch_id = (select public.current_branch_id())));
grant select on public.client_followups to authenticated;

create or replace function public.log_client_followup(
  p_client_id       uuid,
  p_channel         text,
  p_note            text,
  p_contacted_on    date default null,
  p_promised_amount numeric default null,
  p_promised_by     date default null,
  p_next_follow_up  date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid; v_branch uuid; v_id uuid; v_on date := coalesce(p_contacted_on, current_date);
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  select company_id, branch_id into v_company, v_branch from public.clients where id = p_client_id;
  if v_company is null then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);
  if p_channel is null or p_channel not in ('call', 'whatsapp', 'letter', 'visit', 'email') then
    raise exception 'Choose how they were contacted. Nothing has been recorded.';
  end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Write what was said. Nothing has been recorded.'; end if;
  if v_on > current_date then raise exception 'The contact date is in the future. Nothing has been recorded.'; end if;
  if p_promised_amount is not null and p_promised_amount <= 0 then raise exception 'A promised amount must be more than zero. Nothing has been recorded.'; end if;
  if (p_promised_amount is null) <> (p_promised_by is null) then
    raise exception 'A promise needs both an amount and a date. Nothing has been recorded.';
  end if;
  if p_next_follow_up is not null and p_next_follow_up < v_on then
    raise exception 'The next follow-up is before this contact. Nothing has been recorded.';
  end if;
  insert into public.client_followups (company_id, client_id, contacted_on, channel, note, promised_amount, promised_by, next_follow_up)
  values (v_company, p_client_id, v_on, p_channel, btrim(p_note), p_promised_amount, p_promised_by, p_next_follow_up)
  returning id into v_id;
  return v_id;
end $$;

comment on function public.log_client_followup(uuid, text, text, date, numeric, date, date) is
  '0627: log a contact with a client about what they owe. Gate invoices.edit (the receivables write key). One row, named client; moves no money.';

-- ───────────────────────── 2. Write-offs ─────────────────────────
create table if not exists public.client_write_offs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  client_id      uuid not null references public.clients(id),
  amount         numeric(14,2) not null check (amount > 0),
  reason         text not null check (length(btrim(reason)) > 0),
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by   uuid not null default auth.uid(),
  requested_at   timestamptz not null default now(),
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text,
  journal_entry_id uuid,
  check ((status = 'pending') = (decided_by is null))
);
create index if not exists client_write_offs_client_idx on public.client_write_offs (client_id, status);

comment on table public.client_write_offs is
  'DECIDED 2 Nov 2026 (0627): a bad debt written off per client. Requested (invoices.edit), then approved or rejected by a DIFFERENT person holding receivables.write_off_approve. Approval posts Dr bad debt / Cr receivables in the bad_debt_bearer region and reduces the client''s balance (client_receivables_today, client_receivable_ledger, and ar_control''s subledger all subtract approved rows). Written only by request_client_write_off() and decide_client_write_off().';

alter table public.client_write_offs enable row level security;
create policy company_members on public.client_write_offs for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.client_write_offs for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.client_write_offs as restrictive for select
  using ((select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit'))
      or (select public.has_perm('receivables.view')) or (select public.has_perm('accounting.edit'))
      or (select public.has_perm('receivables.write_off_approve')) or (select public.has_perm('accountant.view')));
create policy perm_write_ins on public.client_write_offs as restrictive for insert with check (false);
create policy perm_write_upd on public.client_write_offs as restrictive for update using (false) with check (false);
create policy perm_write_del on public.client_write_offs as restrictive for delete using (false);
create policy branch_scope on public.client_write_offs as restrictive for all
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = client_write_offs.client_id and c.branch_id = (select public.current_branch_id())))
  with check ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = client_write_offs.client_id and c.branch_id = (select public.current_branch_id())));
grant select on public.client_write_offs to authenticated;

insert into public.permission_keys (key, grp, label)
values ('receivables.write_off_approve', 'Banks & Accounting', 'Approve bad-debt write-offs (not your own request)')
on conflict (key) do nothing;

-- The client's balance as the write-off functions need it: brought forward +
-- invoiced − settled (cash + WHT) − approved write-offs. The same terms
-- client_receivables_today adds up; kept here so a definer function does not
-- depend on what the caller's RLS lets an invoker read.
create or replace function public.client_balance_for_write_off(p_client_id uuid)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((select opening_balance from public.clients where id = p_client_id), 0)
       + coalesce((select sum(invoice_amount) from public.invoices where client_id = p_client_id), 0)
       - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                     from public.invoice_payments p left join public.invoices i on i.id = p.invoice_id
                    where coalesce(p.client_id, i.client_id) = p_client_id), 0)
       - coalesce((select sum(amount) from public.client_write_offs where client_id = p_client_id and status = 'approved'), 0)
$$;
revoke all on function public.client_balance_for_write_off(uuid) from public, anon, authenticated;

create or replace function public.request_client_write_off(p_client_id uuid, p_amount numeric, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid; v_branch uuid; v_bal numeric; v_pending numeric; v_id uuid;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  select company_id, branch_id into v_company, v_branch from public.clients where id = p_client_id;
  if v_company is null then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount to write off. Nothing has been recorded.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'Write why this will never be paid. Nothing has been recorded.'; end if;

  v_bal := public.client_balance_for_write_off(p_client_id);
  select coalesce(sum(amount), 0) into v_pending from public.client_write_offs where client_id = p_client_id and status = 'pending';
  if p_amount > v_bal - v_pending + 0.005 then
    raise exception 'The client owes % (with % already waiting for approval), so % cannot be written off. Nothing has been recorded.',
      to_char(v_bal, 'FM999,999,999,990'), to_char(v_pending, 'FM999,999,999,990'), to_char(p_amount, 'FM999,999,999,990');
  end if;

  insert into public.client_write_offs (company_id, client_id, amount, reason)
  values (v_company, p_client_id, round(p_amount, 2), btrim(p_reason))
  returning id into v_id;
  return v_id;
end $$;

comment on function public.request_client_write_off(uuid, numeric, text) is
  '0627: ask for a bad debt to be written off for one client. Gate invoices.edit. Refused above what the client owes less write-offs already waiting. Nothing posts until a different person approves.';

create or replace function public.decide_client_write_off(p_write_off_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.client_write_offs; v_branch uuid; v_bearer text; v_region uuid; v_bad uuid; v_ar uuid; v_bal numeric;
  v_entry uuid; v_n int; v_client_name text;
begin
  perform public.require_perm('receivables.write_off_approve');
  -- tenant guard [resolved]: owning company from p_write_off_id via public.client_write_offs
  if p_write_off_id is not null then perform public.assert_same_company((select company_id from public.client_write_offs where id = p_write_off_id)); end if;

  select * into w from public.client_write_offs where id = p_write_off_id for update;
  if w.id is null then raise exception 'That write-off does not exist. Nothing has been recorded.'; end if;
  select branch_id, name into v_branch, v_client_name from public.clients where id = w.client_id;
  perform public.assert_branch_writable(v_branch);
  if w.status <> 'pending' then raise exception 'This write-off was already %. Nothing has been recorded.', w.status; end if;
  if w.requested_by = auth.uid() then
    raise exception 'You asked for this write-off, so someone else must approve or reject it. Nothing has been recorded.' using errcode = '42501';
  end if;
  if p_approve is null then raise exception 'Choose approve or reject. Nothing has been recorded.'; end if;
  if not p_approve and nullif(btrim(p_note), '') is null then
    raise exception 'Say why it is rejected. Nothing has been recorded.';
  end if;

  if p_approve then
    v_bal := public.client_balance_for_write_off(w.client_id);
    if w.amount > v_bal + 0.005 then
      raise exception 'The client now owes only %, less than this write-off of %. Reject it and ask again. Nothing has been recorded.',
        to_char(v_bal, 'FM999,999,999,990'), to_char(w.amount, 'FM999,999,999,990');
    end if;
    select bad_debt_bearer into v_bearer from public.finance_settings where company_id = w.company_id;
    v_region := case when coalesce(v_bearer, 'region') = 'head_office' then public.head_office_region(w.company_id)
                     else public.receivable_owner_region(w.client_id) end;
    v_bad := public.ensure_bad_debt_account(w.company_id);
    select id into v_ar from public.chart_of_accounts where company_id = w.company_id and system_key = 'ar' limit 1;
    if v_ar is null then raise exception 'This company has no receivables account. Nothing has been recorded.'; end if;

    v_entry := public.post_journal(
      w.company_id, current_date,
      'Bad debt written off: ' || coalesce(v_client_name, 'client') || ' — ' || w.reason,
      'client_write_offs', w.id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', v_bad, 'debit', w.amount, 'credit', 0),
        jsonb_build_object('account_id', v_ar, 'debit', 0, 'credit', w.amount)),
      v_region);
  end if;

  update public.client_write_offs
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), ''),
         journal_entry_id = v_entry
   where id = w.id and status = 'pending';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Expected to decide one write-off, decided %. Nothing has been recorded.', v_n; end if;
end $$;

comment on function public.decide_client_write_off(uuid, boolean, text) is
  '0627: approve (posts Dr bad debt / Cr receivables in the bad_debt_bearer region) or reject a requested write-off. Gate receivables.write_off_approve, and never the requester. Single row by id under a row lock; the balance is re-read at approval so a payment since the request cannot be written off twice.';

revoke all on function public.log_client_followup(uuid, text, text, date, numeric, date, date) from public, anon;
revoke all on function public.request_client_write_off(uuid, numeric, text) from public, anon;
revoke all on function public.decide_client_write_off(uuid, boolean, text) from public, anon;
grant execute on function public.log_client_followup(uuid, text, text, date, numeric, date, date) to authenticated;
grant execute on function public.request_client_write_off(uuid, numeric, text) to authenticated;
grant execute on function public.decide_client_write_off(uuid, boolean, text) to authenticated;

-- The old per-invoice path: withdrawn (see header).
revoke execute on function public.write_off_receivable(uuid, text) from public, anon, authenticated;
comment on function public.write_off_receivable(uuid, text) is
  'WITHDRAWN by 0627 (DECIDED 2 Nov 2026): never used, and it left the client''s balance counting the invoice while ar_control dropped the whole invoice. Bad debts are written off per client by request_client_write_off / decide_client_write_off. Kept, unexecutable by logins, for reverse_write_off and the record.';

-- ───────────────────────── 3. ar_control's subledger counts write-offs ─────────────────────────
do $surgery$
declare
  v_src text; v_new text; v_cnt int;
  v_anchor text := '         + coalesce((select sum(c.opening_balance) from public.clients c
                      where c.company_id = p_company_id), 0) bal';
  v_repl   text := '         + coalesce((select sum(c.opening_balance) from public.clients c
                      where c.company_id = p_company_id), 0)
         -- 0627. Approved client write-offs credit 1100; the subledger drops them too.
         - coalesce((select sum(w.amount) from public.client_write_offs w
                      where w.company_id = p_company_id and w.status = ''approved''), 0) bal';
begin
  v_src := pg_get_functiondef('public.ledger_checks_base(uuid)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then
    raise exception '0627 REFUSED: expected the opening-balance term of ar_sub exactly once in ledger_checks_base, found %.', v_cnt;
  end if;
  v_new := replace(v_src, v_anchor, v_repl);
  execute v_new;
end $surgery$;

-- ───────────────────────── 4. Balance today, restated with write-offs and follow-ups ─────────────────────────
drop function public.client_receivables_today();
create function public.client_receivables_today()
returns table (
  client_id        uuid,
  client_name      text,
  branch_id        uuid,
  brought_forward  numeric,
  invoiced         numeric,
  settled          numeric,
  cash_received    numeric,
  wht_deducted     numeric,
  written_off      numeric,
  balance          numeric,
  owed_before_bastion numeric,
  age_0_30         numeric,
  age_31_60        numeric,
  age_61_90        numeric,
  age_over_90      numeric,
  overdue          numeric,
  open_invoices    int,
  oldest_open_date date,
  wht_awaiting_certificate numeric,
  write_off_pending numeric,
  last_paid_on     date,
  last_paid_mode   text,
  last_paid_amount numeric,
  last_contact_on  date,
  last_contact_channel text,
  last_contact_note text,
  promised_amount  numeric,
  promised_by      date,
  next_follow_up   date
)
language sql
stable
security invoker
set search_path = public
as $$
  with pay as (
    select p.*, coalesce(p.client_id, i.client_id) as cid
      from public.invoice_payments p
      left join public.invoices i on i.id = p.invoice_id
  ),
  rcp as (
    select cid,
           coalesce('chq:' || p.cheque_id::text,
                    'rcp:' || p.created_at::text || ':' || p.payment_date || ':' || coalesce(p.payment_mode, '')) as gk,
           min(p.payment_date) as d,
           max(p.payment_mode) as mode,
           sum(p.amount) as cash,
           sum(coalesce(p.withholding_amount, 0)) as wht
      from pay p
     group by 1, 2
  ),
  paid as (
    select cid, sum(cash + wht) as settled, sum(cash) as cash, sum(wht) as wht
      from rcp group by cid
  ),
  untracked as (
    select i.client_id as cid,
           sum(greatest(0, i.amount_received
                 - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                               from public.invoice_payments p where p.invoice_id = i.id), 0))) as amt
      from public.invoices i group by 1
  ),
  wo as (
    select client_id as cid,
           coalesce(sum(amount) filter (where status = 'approved'), 0) as approved,
           coalesce(sum(amount) filter (where status = 'pending'), 0) as pending
      from public.client_write_offs group by 1
  ),
  last_rcp as (
    select distinct on (cid) cid, d, mode, cash + wht as amt
      from rcp order by cid, d desc, gk desc
  ),
  last_contact as (
    select distinct on (client_id) client_id as cid, contacted_on, channel, note, promised_amount, promised_by, next_follow_up
      from public.client_followups order by client_id, contacted_on desc, created_at desc
  ),
  pending_wht as (
    select cid, sum(coalesce(withholding_amount, 0)) as amt
      from pay where wht_status = 'claimed' group by cid
  ),
  items as (
    select c.id as cid, 0 as ord, null::date as d, null::uuid as invoice_id,
           coalesce(c.opening_balance, 0) as amt
      from public.clients c
    union all
    select i.client_id, 1, i.invoice_date, i.id, i.invoice_amount
      from public.invoices i
  ),
  alloc as (
    select it.*,
           sum(it.amt) over (partition by it.cid order by it.ord, it.d, it.invoice_id
                             rows between unbounded preceding and current row) as cum,
           coalesce(pd.settled, 0) + coalesce(u.amt, 0) + coalesce(w.approved, 0) as paid_total
      from items it
      left join paid pd on pd.cid = it.cid
      left join untracked u on u.cid = it.cid
      left join wo w on w.cid = it.cid
  ),
  left_over as (
    select cid, ord, d, greatest(0, least(amt, cum - paid_total)) as remaining
      from alloc
  ),
  ages as (
    select cid,
           sum(remaining) filter (where ord = 0) as bf_left,
           sum(remaining) filter (where ord = 1 and current_date - d <= 30) as a0,
           sum(remaining) filter (where ord = 1 and current_date - d between 31 and 60) as a31,
           sum(remaining) filter (where ord = 1 and current_date - d between 61 and 90) as a61,
           sum(remaining) filter (where ord = 1 and current_date - d > 90) as a90,
           count(*) filter (where ord = 1 and remaining > 0.005)::int as n_open,
           min(d) filter (where ord = 1 and remaining > 0.005) as oldest
      from left_over group by cid
  )
  select c.id,
         c.name,
         c.branch_id,
         coalesce(c.opening_balance, 0),
         coalesce((select sum(i.invoice_amount) from public.invoices i where i.client_id = c.id), 0),
         coalesce(pd.settled, 0) + coalesce(u.amt, 0),
         coalesce(pd.cash, 0) + coalesce(u.amt, 0),
         coalesce(pd.wht, 0),
         coalesce(w.approved, 0),
         coalesce(c.opening_balance, 0)
           + coalesce((select sum(i.invoice_amount) from public.invoices i where i.client_id = c.id), 0)
           - coalesce(pd.settled, 0) - coalesce(u.amt, 0) - coalesce(w.approved, 0),
         coalesce(a.bf_left, 0),
         coalesce(a.a0, 0),
         coalesce(a.a31, 0),
         coalesce(a.a61, 0),
         coalesce(a.a90, 0),
         -- Overdue = older than 30 days, including whatever is left from before Bastion.
         coalesce(a.bf_left, 0) + coalesce(a.a31, 0) + coalesce(a.a61, 0) + coalesce(a.a90, 0),
         coalesce(a.n_open, 0),
         a.oldest,
         coalesce(pw.amt, 0),
         coalesce(w.pending, 0),
         lr.d,
         lr.mode,
         lr.amt,
         lc.contacted_on,
         lc.channel,
         lc.note,
         lc.promised_amount,
         lc.promised_by,
         lc.next_follow_up
    from public.clients c
    left join paid pd on pd.cid = c.id
    left join untracked u on u.cid = c.id
    left join wo w on w.cid = c.id
    left join ages a on a.cid = c.id
    left join pending_wht pw on pw.cid = c.id
    left join last_rcp lr on lr.cid = c.id
    left join last_contact lc on lc.cid = c.id
   where c.company_id = public.current_company_id()
     and c.name !~* '\(merged into '
$$;

comment on function public.client_receivables_today() is
  '0627 (restating 0626; DECIDED 2 Nov 2026): the Receivables list — per client, balance today = brought forward + invoiced − settled (cash + WHT, A1) − approved write-offs, split by age with credits applied oldest first (brought forward, then invoices by date). overdue = everything older than 30 days including what is left from before Bastion. Also the last contact, any promise, and the next follow-up date. Invoker: RLS decides which clients the caller sees.';
grant execute on function public.client_receivables_today() to authenticated;

-- ───────────────────────── 5. The ledger, restated with write-off lines ─────────────────────────
drop function public.client_receivable_ledger(uuid, date, date);
create function public.client_receivable_ledger(p_client_id uuid, p_from date default null, p_to date default null)
returns table (
  line_no          int,
  line_date        date,
  line_kind        text,      -- opening | invoice | receipt | untracked | write_off
  reference        text,
  for_month        date,
  details          text,
  mode             text,
  cheque_no        text,
  cheque_status    text,
  cheque_status_on date,
  deposited_to     text,
  invoiced         numeric,
  received         numeric,
  wht              numeric,
  written_off      numeric,
  wht_status       text,
  wht_certificate  text,
  balance          numeric,
  payment_ids      uuid[],
  invoice_id       uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  with c as (
    select id, name, coalesce(opening_balance, 0) as bf from public.clients where id = p_client_id
  ),
  pay as (
    select p.*, coalesce(p.client_id, i.client_id) as cid, i.invoice_number
      from public.invoice_payments p
      left join public.invoices i on i.id = p.invoice_id
     where coalesce(p.client_id, i.client_id) = p_client_id
  ),
  rcp as (
    select coalesce('chq:' || p.cheque_id::text,
                    'rcp:' || p.created_at::text || ':' || p.payment_date || ':' || coalesce(p.payment_mode, '')) as gk,
           min(p.payment_date) as d,
           max(p.payment_mode) as mode,
           max(p.cheque_id::text)::uuid as cheque_id,
           max(p.bank_account_id::text)::uuid as bank_account_id,
           max(p.custodian_location_id::text)::uuid as cash_location_id,
           sum(p.amount) as cash,
           sum(coalesce(p.withholding_amount, 0)) as wht,
           string_agg(distinct p.invoice_number, ', ') as invoices,
           string_agg(distinct nullif(btrim(p.notes), ''), ' · ') as notes,
           bool_or(p.wht_status = 'not_deposited') as any_rejected,
           bool_and(coalesce(p.withholding_amount, 0) = 0 or p.wht_status = 'verified') as all_verified,
           string_agg(distinct p.wht_certificate_no, ', ') as certs,
           array_agg(p.id order by p.id) as ids
      from pay p
     group by 1
  ),
  untracked as (
    select i.id, i.invoice_date, i.invoice_number,
           i.amount_received - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                                          from public.invoice_payments p where p.invoice_id = i.id), 0) as amt
      from public.invoices i where i.client_id = p_client_id
  ),
  lines as (
    select i.invoice_date as d, 0 as rk, 'invoice'::text as kind, i.invoice_number as ref,
           coalesce(i.service_month, date_trunc('month', i.period_start)::date) as for_month,
           case when i.invoice_kind::text = 'supplementary' then 'Supplementary invoice' else 'Invoice' end
             || case when i.notes is not null then ' · ' || i.notes else '' end as details,
           null::text as mode, null::text as cheque_no, null::text as cheque_status, null::date as cheque_status_on,
           null::text as deposited_to,
           i.invoice_amount as inv, 0::numeric as cash, 0::numeric as wht, 0::numeric as wo,
           null::text as wht_status, null::text as cert, null::uuid[] as ids, i.id as invoice_id
      from public.invoices i where i.client_id = p_client_id
    union all
    select r.d, 1, 'receipt',
           coalesce(r.invoices, 'On account'),
           null,
           case when r.invoices is null then 'Payment on account' else 'Payment' end
             || case when r.notes is not null then ' · ' || r.notes else '' end,
           case when r.cheque_id is not null then 'Cheque' else r.mode end,
           q.cheque_number,
           q.status,
           case q.status when 'cleared' then q.cleared_at::date when 'bounced' then q.bounced_at::date else q.cheque_date end,
           coalesce(
             (select b.bank_name || coalesce(' ••' || right(regexp_replace(b.account_number, '\D', '', 'g'), 4), '')
                from public.bank_accounts b where b.id = coalesce(r.bank_account_id, q.bank_account_id)),
             (select 'Cash · ' || l.name from public.cash_locations l where l.id = coalesce(r.cash_location_id, q.custodian_location_id))),
           0, r.cash, r.wht, 0,
           case when r.wht = 0 then null
                when r.any_rejected then 'not deposited'
                when r.all_verified then 'certificate received'
                else 'awaiting certificate' end,
           r.certs, r.ids, null
      from rcp r
      left join public.cheques q on q.id = r.cheque_id
    union all
    select u.invoice_date, 2, 'untracked', u.invoice_number, null,
           'Received — how it was paid was never recorded',
           null, null, null, null, 'Not recorded', 0, u.amt, 0, 0, null, null, null, u.id
      from untracked u where u.amt > 0.005
    union all
    select w.decided_at::date, 3, 'write_off', 'Write-off', null,
           'Bad debt written off · ' || w.reason,
           null, null, null, null, null, 0, 0, 0, w.amount, null, null, null, null
      from public.client_write_offs w where w.client_id = p_client_id and w.status = 'approved'
  ),
  opening as (
    select (select bf from c)
           + coalesce(sum(inv - cash - wht - wo) filter (where p_from is not null and d < p_from), 0) as amt
      from lines
  ),
  scoped as (
    select * from lines
     where (p_from is null or d >= p_from) and (p_to is null or d <= p_to)
  ),
  numbered as (
    select s.*, row_number() over (order by s.d, s.rk, s.ref) as n from scoped s
  )
  select 0, p_from,
         'opening',
         case when p_from is null then 'Brought forward' else 'Balance on ' || to_char(p_from, 'DD Mon YYYY') end,
         null::date,
         case when p_from is null then 'Balance before Bastion' else 'Carried from earlier lines' end,
         null, null, null, null, null, 0::numeric, 0::numeric, 0::numeric, 0::numeric, null, null,
         (select amt from opening), null::uuid[], null::uuid
   where exists (select 1 from c)
  union all
  select n::int, d, kind, ref, for_month, details, mode, cheque_no, cheque_status, cheque_status_on, deposited_to,
         inv, cash, wht, wo, wht_status, cert,
         (select amt from opening) + sum(inv - cash - wht - wo) over (order by n),
         ids, invoice_id
    from numbered
   order by 1
$$;

comment on function public.client_receivable_ledger(uuid, date, date) is
  '0627 (restating 0626; DECIDED 2 Nov 2026): one client''s receivable as a statement, by DATE — invoices on their invoice date (with the month they bill for), each receipt as ONE line with mode, cheque, destination, cash and WHT, and each approved write-off on the day it was approved; running balance. Line 0 is the opening. With no dates its last balance equals client_receivables_today().balance — asserted by 0626 and 0627.';
grant execute on function public.client_receivable_ledger(uuid, date, date) to authenticated;

-- ───────────────────────── 6. Totals by region ─────────────────────────
create or replace function public.client_receivables_by_region()
returns table (branch_id uuid, region_name text, clients int, balance numeric, overdue numeric, age_over_90 numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select t.branch_id, coalesce(b.name, 'No region'), count(*)::int,
         sum(t.balance), sum(t.overdue), sum(t.age_over_90)
    from public.client_receivables_today() t
    left join public.branches b on b.id = t.branch_id
   where abs(t.balance) > 0.005
   group by 1, 2
   order by 4 desc
$$;
comment on function public.client_receivables_by_region() is
  '0627: what clients owe, per region, from client_receivables_today() — replaces regional_receivables_aging on screen, which aged invoice by invoice and ignored the before-Bastion balance.';
grant execute on function public.client_receivables_by_region() to authenticated;

-- ───────────────────────── 7. Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_client uuid; v_inv uuid; v_wo uuid; v_msg text; v_ran int := 0; v_bad text;
  v_ar_diff numeric; v_bal numeric; r record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. Restated functions still agree with each other for every client.
    select string_agg(t.client_name, ', ') into v_bad
      from public.client_receivables_today() t
      left join lateral (select x.balance from public.client_receivable_ledger(t.client_id) x order by x.line_no desc limit 1) l on true
     where abs(t.balance - coalesce(l.balance, 0)) > 0.01
        or (t.balance >= 0 and abs(t.balance - (t.owed_before_bastion + t.age_0_30 + t.age_31_60 + t.age_61_90 + t.age_over_90)) > 0.01);
    if v_bad is not null then raise exception '0627 REFUSED: ledger and list disagree, or ages do not add up, for: %', v_bad; end if;
    v_ran := v_ran + 1;

    -- 2. A follow-up is logged and shows on the client's row; a promise without a date is refused by message.
    select client_id into v_client from public.client_receivables_today() where client_name = 'Dolmen City';
    v_msg := null;
    begin perform public.log_client_followup(v_client, 'call', 'Will pay soon', null, 500000, null, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'A promise needs both an amount and a date. Nothing has been recorded.' then raise exception '0627 REFUSED: a promise without a date got "%".', v_msg; end if;
    perform public.log_client_followup(v_client, 'call', 'Accounts promised the October cheque', current_date, 548550, current_date + 7, current_date + 7);
    select * into r from public.client_receivables_today() where client_id = v_client;
    if r.last_contact_channel <> 'call' or r.promised_amount <> 548550 or r.next_follow_up <> current_date + 7 then
      raise exception '0627 REFUSED: the follow-up reads %.', row_to_json(r);
    end if;
    v_ran := v_ran + 1;

    -- 3. A write-off: requested by one person, refused to that same person, approved by another.
    insert into public.clients (company_id, name, branch_id) values (v_co, '0627 test client', '87c67763-e53c-4e0c-8362-38cd8abe4bb2') returning id into v_client;
    insert into public.invoices (company_id, client_id, invoice_number, invoice_date, period_start, period_end, invoice_amount, subtotal, total_due, amount_received, status, total_only)
    values (v_co, v_client, '0627-T-1', current_date, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
            50000, 50000, 50000, 0, 'Unpaid', true) returning id into v_inv;
    select difference into v_ar_diff from public.ledger_checks(v_co) where check_name = 'ar_control_equals_open_invoices';

    v_msg := null;
    begin perform public.request_client_write_off(v_client, 60000, 'Closed down'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg not like 'The client owes 50,000 (with 0 already waiting for approval), so 60,000 cannot be written off.%' then
      raise exception '0627 REFUSED: writing off more than owed got "%".', v_msg;
    end if;
    v_wo := public.request_client_write_off(v_client, 20000, 'Closed down, partner untraceable');

    update public.profiles set permissions = array_append(coalesce(permissions, '{}'), 'receivables.write_off_approve') where id = v_boss and not ('receivables.write_off_approve' = any (coalesce(permissions, '{}')));
    v_msg := null;
    begin perform public.decide_client_write_off(v_wo, true, null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'You asked for this write-off, so someone else must approve or reject it. Nothing has been recorded.' then
      raise exception '0627 REFUSED: the requester approving got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    update public.profiles set permissions = array_append(permissions, 'receivables.write_off_approve') where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    perform public.decide_client_write_off(v_wo, true, 'Agreed');
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    select balance, written_off into r from public.client_receivables_today() where client_id = v_client;
    if r.balance <> 30000 or r.written_off <> 20000 then raise exception '0627 REFUSED: after the write-off the client reads %.', row_to_json(r); end if;
    select * into r from public.client_receivable_ledger(v_client) where line_kind = 'write_off';
    if r.written_off <> 20000 or r.balance <> 30000 then raise exception '0627 REFUSED: the write-off line reads %.', row_to_json(r); end if;
    v_ran := v_ran + 1;

    -- 4. The thing that can break: the receivables control. Its difference must be
    --    exactly what it was before the write-off posted (both sides moved together).
    if (select difference from public.ledger_checks(v_co) where check_name = 'ar_control_equals_open_invoices') <> v_ar_diff then
      raise exception '0627 REFUSED: the write-off moved ar_control''s difference from % to %.', v_ar_diff,
        (select difference from public.ledger_checks(v_co) where check_name = 'ar_control_equals_open_invoices');
    end if;
    if not exists (select 1 from public.client_write_offs where id = v_wo and status = 'approved' and journal_entry_id is not null and decided_by = v_hr) then
      raise exception '0627 REFUSED: the approved write-off has no journal entry or the wrong approver.';
    end if;
    v_ran := v_ran + 1;

    -- 5. The old per-invoice write-off can no longer be called by a login.
    if has_function_privilege('authenticated', 'public.write_off_receivable(uuid,text)', 'execute') then
      raise exception '0627 REFUSED: write_off_receivable is still executable by logins.';
    end if;
    v_ran := v_ran + 1;

    if v_ran <> 6 then raise exception '0627 REFUSED: % of 6 assertions ran.', v_ran; end if;
    raise exception '0627-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0627-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0627 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0627 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0627 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
