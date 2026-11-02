-- 0628 — payment follow-up as its own permission and its own report.
--
-- DECIDED by Shayan, 2 Nov 2026:
--   * A separate key, receivables.follow_up. Some clients are followed up by the
--     ops team, who must see the follow-up list and nothing else: client names,
--     how late, the usual pay day, contact notes and next steps — NO figures
--     (no balance, no invoice, no promise amount). Finance (invoices.edit,
--     invoices.view, receivables.view, accounting.edit) sees the same with amounts.
--   * A client's USUAL PAY DAY (clients.usual_pay_day, 1–31). Invoices go out at
--     the start of the month, so everyone owes something on the 2nd; a client is
--     LATE only once their usual day has passed. With no day set, late is 7 days
--     after the invoice date (finance_settings.followup_after_days). Anything
--     left from before Bastion is always late.
--   * No follow-up owner per client. Each contact can set a NEXT STEP — what, who,
--     by when — and that step is marked done when it is done.
--   * An ops login may record that a promise was made and by when, never how much.
--   * Not in the daily report. A separate Payment follow-up report (Daily Reports →
--     Payment follow-up), exported with figures (finance only) or without.
--
-- HOW THE "NO FIGURES" RULE IS ENFORCED. Not by the screen. An ops login holds
-- receivables.follow_up and no invoice/receivable read key, so RLS already hides
-- invoices and invoice_payments from it. client_followups carries
-- promised_amount, so its perm_read deliberately does NOT include the new key:
-- an ops login reads follow-ups only through client_followup_list() and
-- client_followup_history(), SECURITY DEFINER functions that return every amount
-- as NULL unless the caller holds a finance read key. Asserted below by reading
-- the tables directly as such a login.
--
-- RESTATED: log_client_followup has one author (0627) and is restated behind its
-- digest; its signature gains the next step, so it is dropped and recreated.
--
-- client_receivables_today BECOMES FINANCE-ONLY. As an invoker function it
-- already showed an ops login no invoices or receipts — but clients.opening_balance
-- is readable by every login of the company, so it still showed each client's
-- before-Bastion balance. Its body moves, unchanged, to client_receivables_base()
-- (not executable by logins); client_receivables_today() becomes that base
-- filtered to callers who can see amounts. client_followup_list() reads the base
-- and blanks the amounts itself.
--
-- KNOWN AND NOT CHANGED HERE: clients.opening_balance itself is readable through
-- the API by any login of the company (clients has no perm_read). No ops screen
-- shows it; closing it means a column grant on a table half the app selects "*"
-- from, which is its own change. DEFERRED, put to Shayan 2 Nov 2026.

do $pre$
begin
  if md5(pg_get_functiondef('public.client_receivables_today()'::regprocedure)) <> '521e2f3cc73d33e161f9c356514e99c1' then
    raise exception '0628 REFUSED: client_receivables_today is not the body 0627 wrote — someone edited it since.';
  end if;
  if md5(pg_get_functiondef('public.log_client_followup(uuid,text,text,date,numeric,date,date)'::regprocedure)) <> '567b4959927671c6fbbabb46e2cc6916' then
    raise exception '0628 REFUSED: log_client_followup is not the body 0627 wrote — someone edited it since.';
  end if;
end $pre$;

-- ───────────────────────── 1. The key, the pay day, the fallback ─────────────────────────
insert into public.permission_keys (key, grp, label)
values ('receivables.follow_up', 'Banks & Accounting', 'Follow up client payments (names and dates only, no amounts)')
on conflict (key) do nothing;

alter table public.clients add column if not exists usual_pay_day smallint check (usual_pay_day between 1 and 31);
comment on column public.clients.usual_pay_day is
  'DECIDED 2 Nov 2026 (0628): the day of the month this client normally pays (e.g. 3, 5, 18). A client is late for follow-up only after this day has passed for its oldest unpaid invoice. Null: late finance_settings.followup_after_days after the invoice date. Set by set_client_pay_day().';

alter table public.finance_settings add column if not exists followup_after_days smallint not null default 7 check (followup_after_days between 0 and 60);
comment on column public.finance_settings.followup_after_days is
  'DECIDED 2 Nov 2026 (0628): days after the invoice date a client with no usual pay day counts as late for follow-up. 7: invoices go out on the 1st, so an unpaid client appears on the 8th.';

-- ───────────────────────── 2. Next steps on a contact ─────────────────────────
alter table public.client_followups
  add column if not exists next_step text,
  add column if not exists next_step_assignee uuid references public.profiles(id),
  add column if not exists next_step_done_at timestamptz,
  add column if not exists next_step_done_by uuid;

-- ───────────────────────── 3. Who may do what ─────────────────────────
-- Any of the finance read keys: may see amounts.
create or replace function public.can_see_receivable_amounts()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select public.has_perm('invoices.view') or public.has_perm('invoices.edit')
      or public.has_perm('receivables.view') or public.has_perm('accounting.edit')
$$;
comment on function public.can_see_receivable_amounts() is
  '0628: true when the caller holds a key that already reads invoices (finance). A receivables.follow_up-only login is false and is shown no amounts.';

create or replace function public.require_follow_up_access(p_write boolean)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_write then
    if not (public.has_perm('receivables.follow_up') or public.has_perm('invoices.edit')) then
      raise exception 'Your login needs the "Follow up client payments" permission for this. Ask a super admin.' using errcode = '42501';
    end if;
  elsif not (public.has_perm('receivables.follow_up') or public.can_see_receivable_amounts()) then
    raise exception 'Your login needs the "Follow up client payments" permission for this. Ask a super admin.' using errcode = '42501';
  end if;
end $$;

-- ───────────────────────── 3b. Balance today: the body moves to a base ─────────────────────────
do $split$
declare v_src text; v_cnt int;
  v_from text := 'FUNCTION public.client_receivables_today()';
begin
  v_src := pg_get_functiondef('public.client_receivables_today()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_cnt <> 1 then raise exception '0628 REFUSED: expected the function header exactly once, found %.', v_cnt; end if;
  execute replace(v_src, v_from, 'FUNCTION public.client_receivables_base()');
end $split$;
revoke all on function public.client_receivables_base() from public, anon, authenticated;
comment on function public.client_receivables_base() is
  '0628: the body of client_receivables_today (0627), moved unchanged. Not executable by logins: read through client_receivables_today() (finance only) or client_followup_list() (amounts blanked for ops).';

drop function public.client_receivables_by_region();
drop function public.client_receivables_today();
create function public.client_receivables_today()
returns table (
  client_id uuid, client_name text, branch_id uuid, brought_forward numeric, invoiced numeric, settled numeric,
  cash_received numeric, wht_deducted numeric, written_off numeric, balance numeric, owed_before_bastion numeric,
  age_0_30 numeric, age_31_60 numeric, age_61_90 numeric, age_over_90 numeric, overdue numeric, open_invoices int,
  oldest_open_date date, wht_awaiting_certificate numeric, write_off_pending numeric, last_paid_on date,
  last_paid_mode text, last_paid_amount numeric, last_contact_on date, last_contact_channel text, last_contact_note text,
  promised_amount numeric, promised_by date, next_follow_up date
)
language sql
stable
security definer
set search_path = public
as $$
  -- Definer only so it can call the base; the base keeps its own company filter,
  -- and the region filter is applied here, as RLS applied it before.
  select b.* from public.client_receivables_base() b
   where public.can_see_receivable_amounts()
     and ((not public.is_branched_user()) or public.is_super_super_admin() or b.branch_id = public.current_branch_id())
$$;
comment on function public.client_receivables_today() is
  '0628: the Receivables list (see client_receivables_base, 0627''s body unchanged) for callers who can see amounts — empty for anyone else, so an ops login cannot read balances through it. Region-pinned logins see their region only.';
grant execute on function public.client_receivables_today() to authenticated;

create function public.client_receivables_by_region()
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
  '0627/0628: what clients owe, per region, from client_receivables_today() (finance only).';
grant execute on function public.client_receivables_by_region() to authenticated;

-- ───────────────────────── 4. Logging a contact (restated) ─────────────────────────
drop function public.log_client_followup(uuid, text, text, date, numeric, date, date);
create function public.log_client_followup(
  p_client_id          uuid,
  p_channel            text,
  p_note               text,
  p_contacted_on       date default null,
  p_promised_amount    numeric default null,
  p_promised_by        date default null,
  p_next_follow_up     date default null,
  p_next_step          text default null,
  p_next_step_assignee uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid; v_branch uuid; v_id uuid; v_on date := coalesce(p_contacted_on, current_date);
begin
  perform public.require_follow_up_access(true);
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  -- tenant guard [resolved]: owning company from p_next_step_assignee via public.profiles
  if p_next_step_assignee is not null then perform public.assert_same_company((select company_id from public.profiles where id = p_next_step_assignee)); end if;
  select company_id, branch_id into v_company, v_branch from public.clients where id = p_client_id;
  if v_company is null then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);
  if p_channel is null or p_channel not in ('call', 'whatsapp', 'letter', 'visit', 'email') then
    raise exception 'Choose how they were contacted. Nothing has been recorded.';
  end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Write what was said. Nothing has been recorded.'; end if;
  if v_on > current_date then raise exception 'The contact date is in the future. Nothing has been recorded.'; end if;
  if p_promised_amount is not null and not public.can_see_receivable_amounts() then
    raise exception 'Your login records the date of a promise, not the amount. Nothing has been recorded.' using errcode = '42501';
  end if;
  if p_promised_amount is not null and p_promised_amount <= 0 then raise exception 'A promised amount must be more than zero. Nothing has been recorded.'; end if;
  if p_promised_amount is not null and p_promised_by is null then
    raise exception 'A promise needs a date. Nothing has been recorded.';
  end if;
  if p_next_follow_up is not null and p_next_follow_up < v_on then
    raise exception 'The next follow-up is before this contact. Nothing has been recorded.';
  end if;
  if (nullif(btrim(p_next_step), '') is null) and p_next_step_assignee is not null then
    raise exception 'Write what the next step is. Nothing has been recorded.';
  end if;
  if nullif(btrim(p_next_step), '') is not null and p_next_follow_up is null then
    raise exception 'Give the next step a date. Nothing has been recorded.';
  end if;
  insert into public.client_followups (company_id, client_id, contacted_on, channel, note, promised_amount, promised_by, next_follow_up, next_step, next_step_assignee)
  values (v_company, p_client_id, v_on, p_channel, btrim(p_note), p_promised_amount, p_promised_by, p_next_follow_up,
          nullif(btrim(p_next_step), ''), p_next_step_assignee)
  returning id into v_id;
  return v_id;
end $$;
comment on function public.log_client_followup(uuid, text, text, date, numeric, date, date, text, uuid) is
  '0628 (restating 0627): log a contact with a client about payment, with an optional promise and next step (what, who, by when). Gate receivables.follow_up or invoices.edit; a promise AMOUNT only from a login that can see amounts. One row, named client; moves no money.';

create or replace function public.complete_followup_step(p_followup_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_branch uuid; v_n int;
begin
  perform public.require_follow_up_access(true);
  -- tenant guard [resolved]: owning company from p_followup_id via public.client_followups
  if p_followup_id is not null then perform public.assert_same_company((select company_id from public.client_followups where id = p_followup_id)); end if;
  select c.branch_id into v_branch from public.client_followups f join public.clients c on c.id = f.client_id where f.id = p_followup_id;
  perform public.assert_branch_writable(v_branch);
  update public.client_followups set next_step_done_at = now(), next_step_done_by = auth.uid()
   where id = p_followup_id and next_step is not null and next_step_done_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'That step is not open (already done, or there is no step). Nothing has been recorded.'; end if;
end $$;
comment on function public.complete_followup_step(uuid) is '0628: mark a follow-up''s next step done. Gate receivables.follow_up or invoices.edit. One row by id.';

create or replace function public.set_client_pay_day(p_client_id uuid, p_day smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_branch uuid; v_n int;
begin
  perform public.require_follow_up_access(true);
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  select branch_id into v_branch from public.clients where id = p_client_id;
  perform public.assert_branch_writable(v_branch);
  if p_day is not null and (p_day < 1 or p_day > 31) then raise exception 'A pay day is 1 to 31. Nothing has been recorded.'; end if;
  update public.clients set usual_pay_day = p_day where id = p_client_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
end $$;
comment on function public.set_client_pay_day(uuid, smallint) is '0628: set (or clear, with null) the day of the month a client normally pays. Gate receivables.follow_up or invoices.edit.';

-- ───────────────────────── 5. The follow-up list ─────────────────────────
-- SECURITY DEFINER because an ops login cannot read invoices; the rows it may
-- see are therefore filtered HERE — the caller's company, and the caller's region
-- for a region-pinned login — and every amount is NULL unless the caller can
-- already see amounts.
create or replace function public.client_followup_list()
returns table (
  client_id        uuid,
  client_name      text,
  branch_id        uuid,
  region_name      text,
  usual_pay_day    smallint,
  is_late          boolean,
  late_since       date,
  days_late        int,
  from_before_bastion boolean,
  balance          numeric,
  overdue          numeric,
  last_contact_on  date,
  last_contact_channel text,
  last_contact_note text,
  promised_by      date,
  promised_amount  numeric,
  next_follow_up   date,
  next_step        text,
  next_step_assignee uuid,
  next_step_assignee_name text,
  next_step_followup_id uuid,
  next_step_done   boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_amounts boolean;
  v_after   int;
  v_branch  uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
begin
  perform public.require_follow_up_access(false);
  v_amounts := public.can_see_receivable_amounts();
  select coalesce(followup_after_days, 7) into v_after from public.finance_settings where company_id = public.current_company_id();
  v_after := coalesce(v_after, 7);

  return query
  with t as (
    select * from public.client_receivables_base() r
     where v_branch is null or r.branch_id = v_branch
  ),
  due as (
    select t.*, c.usual_pay_day as pay_day,
           case
             when t.owed_before_bastion > 0.5 then null::date
             when t.oldest_open_date is null then null::date
             when c.usual_pay_day is null then t.oldest_open_date + v_after
             else (
               -- The first occurrence of the pay day on or after the invoice date
               -- (a 31st in a short month falls on its last day).
               select case when m1 >= t.oldest_open_date then m1 else m2 end
                 from (select make_date(extract(year from t.oldest_open_date)::int, extract(month from t.oldest_open_date)::int,
                                        least(c.usual_pay_day::int, extract(day from (date_trunc('month', t.oldest_open_date) + interval '1 month - 1 day'))::int)) m1,
                              make_date(extract(year from t.oldest_open_date + interval '1 month')::int, extract(month from t.oldest_open_date + interval '1 month')::int,
                                        least(c.usual_pay_day::int, extract(day from (date_trunc('month', t.oldest_open_date + interval '1 month') + interval '1 month - 1 day'))::int)) m2) x
             )
           end as due_on
      from t join public.clients c on c.id = t.client_id
  ),
  last_step as (
    select distinct on (f.client_id) f.client_id as cid, f.id, f.next_step, f.next_step_assignee, f.next_follow_up, f.next_step_done_at
      from public.client_followups f
     where f.next_step is not null
     order by f.client_id, f.contacted_on desc, f.created_at desc
  )
  select d.client_id, d.client_name, d.branch_id, b.name,
         d.pay_day,
         d.balance > 0.5 and (d.owed_before_bastion > 0.5 or (d.due_on is not null and current_date > d.due_on)),
         d.due_on,
         case when d.due_on is not null and current_date > d.due_on then (current_date - d.due_on)::int end,
         d.owed_before_bastion > 0.5,
         case when v_amounts then d.balance end,
         case when v_amounts then d.overdue end,
         d.last_contact_on, d.last_contact_channel, d.last_contact_note,
         d.promised_by,
         case when v_amounts then d.promised_amount end,
         d.next_follow_up,
         ls.next_step, ls.next_step_assignee, p.full_name, ls.id, ls.next_step_done_at is not null
    from due d
    left join public.branches b on b.id = d.branch_id
    left join last_step ls on ls.cid = d.client_id
    left join public.profiles p on p.id = ls.next_step_assignee
   where d.balance > 0.5;
end $$;
comment on function public.client_followup_list() is
  '0628 (DECIDED 2 Nov 2026): every client who owes money, with whether they are LATE (past their usual pay day for their oldest unpaid invoice, or followup_after_days after it when no day is set; anything from before Bastion is always late), the last contact, promise date, and the open next step. Amounts are NULL unless the caller holds a finance read key. Definer, scoped here to the caller''s company and region; gate receivables.follow_up or a finance read key.';

create or replace function public.client_followup_history(p_client_id uuid)
returns table (
  id uuid, contacted_on date, channel text, note text, promised_by date, promised_amount numeric,
  next_follow_up date, next_step text, next_step_assignee_name text, next_step_done_at timestamptz, logged_by_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_amounts boolean; v_branch uuid;
begin
  perform public.require_follow_up_access(false);
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;
  select c.branch_id into v_branch from public.clients c where c.id = p_client_id;
  if public.is_branched_user() and not public.is_super_super_admin() and v_branch is distinct from public.current_branch_id() then
    raise exception 'This client is in another region.' using errcode = '42501';
  end if;
  v_amounts := public.can_see_receivable_amounts();
  return query
  select f.id, f.contacted_on, f.channel, f.note, f.promised_by,
         case when v_amounts then f.promised_amount end,
         f.next_follow_up, f.next_step, pa.full_name, f.next_step_done_at, pl.full_name
    from public.client_followups f
    left join public.profiles pa on pa.id = f.next_step_assignee
    left join public.profiles pl on pl.id = f.created_by
   where f.client_id = p_client_id
   order by f.contacted_on desc, f.created_at desc;
end $$;
comment on function public.client_followup_history(uuid) is
  '0628: one client''s follow-up history, amounts NULL unless the caller can see amounts. Gate as client_followup_list.';

-- People a next step can be given to: active logins of the caller's company.
create or replace function public.followup_assignees()
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_follow_up_access(false);
  return query
  select p.id, p.full_name from public.profiles p
   where p.company_id = public.current_company_id() and p.disabled_at is null and coalesce(p.full_name, '') <> ''
     and coalesce(p.user_type, '') <> 'supervisor'
   order by p.full_name;
end $$;

revoke all on function public.log_client_followup(uuid, text, text, date, numeric, date, date, text, uuid) from public, anon;
revoke all on function public.complete_followup_step(uuid) from public, anon;
revoke all on function public.set_client_pay_day(uuid, smallint) from public, anon;
revoke all on function public.client_followup_list() from public, anon;
revoke all on function public.client_followup_history(uuid) from public, anon;
revoke all on function public.followup_assignees() from public, anon;
grant execute on function public.log_client_followup(uuid, text, text, date, numeric, date, date, text, uuid) to authenticated;
grant execute on function public.complete_followup_step(uuid) to authenticated;
grant execute on function public.set_client_pay_day(uuid, smallint) to authenticated;
grant execute on function public.client_followup_list() to authenticated;
grant execute on function public.client_followup_history(uuid) to authenticated;
grant execute on function public.followup_assignees() to authenticated;
grant execute on function public.can_see_receivable_amounts() to authenticated;
grant execute on function public.require_follow_up_access(boolean) to authenticated;

-- ───────────────────────── 6. Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_client uuid; v_inv uuid; v_fu uuid; v_msg text; v_ran int := 0; v_n int; r record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- A client with an unpaid invoice dated 10 days ago, no pay day: late 3 days (10 − 7).
    insert into public.clients (company_id, name, branch_id) values (v_co, '0628 test client', '87c67763-e53c-4e0c-8362-38cd8abe4bb2') returning id into v_client;
    insert into public.invoices (company_id, client_id, invoice_number, invoice_date, period_start, period_end, invoice_amount, subtotal, total_due, amount_received, status, total_only)
    values (v_co, v_client, '0628-T-1', current_date - 10, date_trunc('month', current_date - 10)::date, (date_trunc('month', current_date - 10) + interval '1 month - 1 day')::date,
            40000, 40000, 40000, 0, 'Unpaid', true) returning id into v_inv;
    select * into r from public.client_followup_list() where client_id = v_client;
    if not r.is_late or r.days_late <> 3 or r.balance <> 40000 then raise exception '0628 REFUSED: with no pay day the client reads %.', row_to_json(r); end if;
    v_ran := v_ran + 1;

    -- 1b. Pay day = the invoice's own day of month: due that day, so 10 days late.
    perform public.set_client_pay_day(v_client, extract(day from current_date - 10)::smallint);
    select * into r from public.client_followup_list() where client_id = v_client;
    if r.days_late <> 10 or r.late_since <> current_date - 10 then raise exception '0628 REFUSED: with a pay day the client reads %.', row_to_json(r); end if;
    v_ran := v_ran + 1;

    -- 2. An ops login: only receivables.follow_up.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);

    select * into r from public.client_followup_list() where client_id = v_client;
    if r.client_id is null or r.balance is not null or r.overdue is not null or not r.is_late then
      raise exception '0628 REFUSED: an ops login''s row reads %.', row_to_json(r);
    end if;
    v_ran := v_ran + 1;

    -- 3. It may record a promise date, never an amount (refused by message).
    v_msg := null;
    begin perform public.log_client_followup(v_client, 'visit', 'Met the manager', null, 40000, current_date + 3, null, null, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Your login records the date of a promise, not the amount. Nothing has been recorded.' then
      raise exception '0628 REFUSED: an ops promise amount got "%".', v_msg;
    end if;
    v_fu := public.log_client_followup(v_client, 'visit', 'Met the manager, cheque Friday', null, null, current_date + 3, current_date + 3, 'Collect the cheque', v_hr);
    select * into r from public.client_followup_list() where client_id = v_client;
    if r.promised_by <> current_date + 3 or r.next_step <> 'Collect the cheque' or r.next_step_assignee <> v_hr or r.next_step_done then
      raise exception '0628 REFUSED: after the visit the row reads %.', row_to_json(r);
    end if;
    perform public.complete_followup_step(v_fu);
    if not (select next_step_done from public.client_followup_list() where client_id = v_client) then raise exception '0628 REFUSED: the step was not marked done.'; end if;
    v_ran := v_ran + 1;

    -- 4. The thing that can break: can this login read an amount any other way?
    --    Read the tables directly as the authenticated role.
    begin
      execute 'set local role authenticated';
      select count(*) into v_n from public.invoices;
      if v_n <> 0 then raise exception '0628 REFUSED: an ops login can read % invoices.', v_n; end if;
      select count(*) into v_n from public.invoice_payments;
      if v_n <> 0 then raise exception '0628 REFUSED: an ops login can read % receipts.', v_n; end if;
      select count(*) into v_n from public.client_followups;
      if v_n <> 0 then raise exception '0628 REFUSED: an ops login can read client_followups (and its promised_amount) directly.'; end if;
      select count(*) into v_n from public.client_receivables_today();
      if v_n <> 0 then raise exception '0628 REFUSED: client_receivables_today shows an ops login % clients.', v_n; end if;
      execute 'reset role';
    end;
    if exists (select 1 from public.client_followup_history(v_client) where promised_amount is not null) then
      raise exception '0628 REFUSED: history shows an ops login a promise amount.';
    end if;
    v_ran := v_ran + 1;

    -- 5. A login with neither key is refused, by message.
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['employees.view'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null;
    begin perform * from public.client_followup_list(); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Your login needs the "Follow up client payments" permission for this. Ask a super admin.' then
      raise exception '0628 REFUSED: a login without the key got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    if v_ran <> 6 then raise exception '0628 REFUSED: % of 6 assertions ran.', v_ran; end if;
    raise exception '0628-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0628-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0628 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0628 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0628 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
