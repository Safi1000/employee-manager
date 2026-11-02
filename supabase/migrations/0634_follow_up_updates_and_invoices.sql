-- 0634 — Payment Follow-up: an updates summary, and each client's invoice delivery.
--
-- DECIDED by Shayan, 2 Nov 2026: the follow-up screen shows what has happened
-- (payments received, contacts logged, promises made and missed, steps done,
-- invoices delivered) and, per client, whether last month's invoice was
-- delivered or is missing — on screen, in the PDF and in an Excel export. The
-- Finance Report's follow-up section reads the same summary, so the two can
-- never disagree.
--
-- Both functions follow client_followup_list(): gated by
-- require_follow_up_access(false), so the ops team (receivables.follow_up) can
-- read them, and every AMOUNT is NULL unless can_see_receivable_amounts(). New
-- functions rather than another edit to client_followup_list, which already
-- has two authors (0628, 0630).

-- ───────────────────────── 1. Last month's invoice, per client ─────────────────────────
create or replace function public.client_followup_invoices(p_month date default null)
returns table (client_id uuid, client_name text, branch_id uuid, invoice_id uuid, invoice_number text, for_month date, invoice_date date, amount numeric,
               delivered_on date, delivered_method text, missing boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_co      uuid := public.current_company_id();
  v_branch  uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
  v_month   date := date_trunc('month', coalesce(p_month, (date_trunc('month', current_date) - interval '1 month')::date))::date;
  v_amounts boolean;
begin
  perform public.require_follow_up_access(false);
  -- Stated in the body for security_gaps(): the amounts are finance only.
  v_amounts := public.can_see_receivable_amounts() or public.has_perm('invoices.view');
  return query
    select i.client_id, c.name, c.branch_id, i.id, i.invoice_number, v_month, i.invoice_date,
           case when v_amounts then i.invoice_amount end,
           d.delivered_on, d.method, false
      from public.invoices i join public.clients c on c.id = i.client_id
      left join public.invoice_deliveries d on d.invoice_id = i.id
     where i.company_id = v_co and coalesce(i.service_month, date_trunc('month', i.period_start)::date) = v_month
       and (v_branch is null or c.branch_id = v_branch)
    union all
    select m.client_id, m.client_name, m.branch_id, null::uuid, null::text, v_month, null::date, null::numeric, null::date, null::text, true
      from public.invoices_missing(v_month) m
     where v_branch is null or m.branch_id = v_branch;
end $$;
comment on function public.client_followup_invoices(date) is
  '0634: each client''s invoice(s) for a month (default last month) with delivery date and how, plus a row per client with a running contract and no invoice (missing). Amounts finance only. Gate require_follow_up_access(false).';

-- ───────────────────────── 2. What happened, for the updates summary ─────────────────────────
create or replace function public.followup_updates(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_co      uuid := public.current_company_id();
  v_branch  uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
  v_amounts boolean;
begin
  perform public.require_follow_up_access(false);
  -- Stated in the body for security_gaps(): the amounts are finance only.
  v_amounts := public.can_see_receivable_amounts() or public.has_perm('invoices.view');
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    -- Payments ENTERED in the period (a backdated one still appears once).
    'payments', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'branch_id', c.branch_id, 'on', p.payment_date,
        'mode', case when p.cheque_id is not null then 'Cheque' else p.payment_mode end,
        'amount', case when v_amounts then p.amount end) order by p.payment_date desc, c.name)
      from public.invoice_payments p left join public.invoices i on i.id = p.invoice_id
      join public.clients c on c.id = coalesce(p.client_id, i.client_id)
      where p.company_id = v_co and p.created_at >= p_from and p.created_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'branch_id', c.branch_id, 'on', f.contacted_on, 'channel', f.channel,
        'note', f.note, 'promised_by', f.promised_by, 'promised_amount', case when v_amounts then f.promised_amount end,
        'next_step', f.next_step, 'by', pr.full_name) order by f.created_at desc)
      from public.client_followups f join public.clients c on c.id = f.client_id left join public.profiles pr on pr.id = f.created_by
      where f.company_id = v_co and f.created_at >= p_from and f.created_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),
    'steps_done', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'branch_id', c.branch_id, 'step', f.next_step,
        'at', f.next_step_done_at, 'by', pr.full_name) order by f.next_step_done_at desc)
      from public.client_followups f join public.clients c on c.id = f.client_id left join public.profiles pr on pr.id = f.next_step_done_by
      where f.company_id = v_co and f.next_step_done_at >= p_from and f.next_step_done_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),
    'delivered', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'branch_id', c.branch_id, 'number', i.invoice_number,
        'on', d.delivered_on, 'method', d.method, 'amount', case when v_amounts then i.invoice_amount end) order by d.marked_at desc)
      from public.invoice_deliveries d join public.invoices i on i.id = d.invoice_id join public.clients c on c.id = i.client_id
      where d.company_id = v_co and d.marked_at >= p_from and d.marked_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),
    -- Promises whose date has passed while the client is still overdue: a state, not period-bound.
    'promises_missed', coalesce((select jsonb_agg(jsonb_build_object('client_id', x.client_id, 'client', x.client_name, 'branch_id', x.branch_id,
        'promised_by', x.promised_by, 'promised_amount', case when v_amounts then x.promised_amount end) order by x.promised_by)
      from public.client_receivables_base() x
      where x.promised_by < current_date and x.overdue > 0.5 and (v_branch is null or x.branch_id = v_branch)), '[]'::jsonb),
    -- Next steps due today or earlier and not done: a state.
    'steps_due', coalesce((select jsonb_agg(jsonb_build_object('client_id', c.id, 'client', c.name, 'branch_id', c.branch_id, 'step', f.next_step,
        'due', f.next_follow_up, 'who', pa.full_name) order by f.next_follow_up)
      from public.client_followups f join public.clients c on c.id = f.client_id left join public.profiles pa on pa.id = f.next_step_assignee
      where f.company_id = v_co and f.next_step is not null and f.next_step_done_at is null and f.next_follow_up <= current_date
        and not exists (select 1 from public.client_followups g where g.client_id = f.client_id and g.created_at > f.created_at)
        and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb)
  );
end $$;
comment on function public.followup_updates(timestamptz, timestamptz) is
  '0634: the follow-up updates summary — payments entered, contacts logged, steps done and invoices marked delivered between p_from and p_to; promises missed and steps due now. Amounts finance only. Gate require_follow_up_access(false).';

revoke all on function public.client_followup_invoices(date) from public, anon;
revoke all on function public.followup_updates(timestamptz, timestamptz) from public, anon;
grant execute on function public.client_followup_invoices(date) to authenticated;
grant execute on function public.followup_updates(timestamptz, timestamptz) to authenticated;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_msg text; v_ran int := 0; v_n int; v_r jsonb;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. October: Emaar's invoice reads delivered by hand on 2 Nov; HMC's is not delivered; an amount is shown to finance.
    select count(*) into v_n from public.client_followup_invoices(date '2026-10-01') x
     where x.invoice_number = 'GGS/EPK/10/26' and x.delivered_on = date '2026-11-02' and x.delivered_method = 'hand' and x.amount is not null;
    if v_n <> 1 then raise exception '0634 REFUSED: Emaar''s October invoice does not read delivered by hand on 2 Nov.'; end if;
    select count(*) into v_n from public.client_followup_invoices(date '2026-10-01') x where x.invoice_number = 'GGS/HMC/10/26' and x.delivered_on is null;
    if v_n <> 1 then raise exception '0634 REFUSED: HMC''s October invoice should read not delivered.'; end if;
    v_ran := v_ran + 1;

    -- 2. The updates summary has every section, and the deliveries marked today are in it.
    v_r := public.followup_updates(now() - interval '1 day', now() + interval '1 second');
    if not (v_r ? 'payments' and v_r ? 'contacts' and v_r ? 'steps_done' and v_r ? 'delivered' and v_r ? 'promises_missed' and v_r ? 'steps_due') then
      raise exception '0634 REFUSED: the updates summary is missing a section.';
    end if;
    v_ran := v_ran + 1;

    -- 3. A follow-up-only login reads both, with every amount NULL.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    select count(*) into v_n from public.client_followup_invoices(date '2026-10-01') x where x.amount is not null;
    if v_n <> 0 then raise exception '0634 REFUSED: an ops login was shown % invoice amounts.', v_n; end if;
    select count(*) into v_n from public.client_followup_invoices(date '2026-10-01') x where x.invoice_number = 'GGS/EPK/10/26';
    if v_n <> 1 then raise exception '0634 REFUSED: an ops login cannot see the invoice delivery.'; end if;
    v_r := public.followup_updates(now() - interval '30 days', now());
    if exists (select 1 from jsonb_array_elements(v_r -> 'payments') p where p ->> 'amount' is not null)
       or exists (select 1 from jsonb_array_elements(v_r -> 'delivered') p where p ->> 'amount' is not null) then
      raise exception '0634 REFUSED: an ops login was shown an amount in the updates summary.';
    end if;
    v_ran := v_ran + 1;

    -- 4. A login with neither key is refused, by message.
    -- (only a super admin may change a login's permissions, so switch back to set them)
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    update public.profiles set permissions = array['attendance.view'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.followup_updates(now() - interval '1 day', now()); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Your login needs the "Follow up client payments" permission for this. Ask a super admin.' then raise exception '0634 REFUSED: a login without follow-up access got "%".', v_msg; end if;
    v_ran := v_ran + 1;

    if v_ran <> 4 then raise exception '0634 REFUSED: % of 4 assertions ran.', v_ran; end if;
    raise exception '0634-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0634-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0634 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0634 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
