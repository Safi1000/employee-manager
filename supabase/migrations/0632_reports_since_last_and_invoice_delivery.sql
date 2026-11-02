-- 0632 — invoice delivery, missing invoices, and reports that cover everything
--        entered since the last one: finance, HR changes, and who did what.
--
-- DECIDED by Shayan, 2 Nov 2026:
--   * Invoices get a DELIVERED tick (how: email / WhatsApp / by hand / courier,
--     when, by whom) — anyone with invoices.edit. Generator-made invoices are
--     shown as Auto. Active contracts with no invoice for a month are listed as
--     MISSING.
--   * No panel where anyone lists things by hand. Every report reads what the
--     system already recorded, and covers everything ENTERED since the report
--     was last EXPORTED — by entry time (created_at), so a backdated entry still
--     appears in the next report. Each export is logged in report_runs; the next
--     report starts where the last one ended. Dates can still be picked by hand.
--   * A FINANCE report (accounting snapshot): invoices raised / delivered /
--     undelivered / missing, payments received, expenses, salaries paid and still
--     to pay, receivables and late clients, follow-ups, write-offs and items
--     waiting on someone. The ATTENDANCE report gains staff changes: hired, left,
--     transferred, re-hired, salary changes, documents expiring.
--   * A CEO dashboard (new key dashboard.ceo) shows every report live, plus a
--     PEOPLE view: what each login did, from the records they already create.
--
-- EVERYTHING HERE READS; nothing moves money. The report functions are SECURITY
-- DEFINER only so one call can gather across tables a single login might not
-- read individually; each is gated, scoped to the caller's company, and to the
-- caller's region for a region-pinned login.

-- ───────────────────────── 1. Invoice delivery ─────────────────────────
create table public.invoice_deliveries (
  invoice_id    uuid primary key references public.invoices(id) on delete cascade,
  company_id    uuid not null references public.companies(id),
  delivered_on  date not null,
  method        text not null check (method in ('email', 'whatsapp', 'hand', 'courier', 'portal')),
  note          text,
  marked_by     uuid default auth.uid(),
  marked_at     timestamptz not null default now()
);
comment on table public.invoice_deliveries is
  'DECIDED 2 Nov 2026 (0632): an invoice was delivered to the client — how, when, by whom. One row per invoice; deleting it un-ticks. No money. Written only by mark_invoice_delivered / unmark_invoice_delivered.';
alter table public.invoice_deliveries enable row level security;
create policy company_members on public.invoice_deliveries for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.invoice_deliveries for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_write_ins on public.invoice_deliveries as restrictive for insert with check (false);
create policy perm_write_upd on public.invoice_deliveries as restrictive for update using (false) with check (false);
create policy perm_write_del on public.invoice_deliveries as restrictive for delete using (false);
grant select on public.invoice_deliveries to authenticated;

create or replace function public.mark_invoice_delivered(p_invoice_id uuid, p_method text, p_delivered_on date default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid; v_branch uuid; v_on date := coalesce(p_delivered_on, current_date);
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_invoice_id via public.invoices
  if p_invoice_id is not null then perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id)); end if;
  select i.company_id, c.branch_id into v_company, v_branch from public.invoices i join public.clients c on c.id = i.client_id where i.id = p_invoice_id;
  if v_company is null then raise exception 'That invoice does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(v_branch);
  if p_method is null or p_method not in ('email', 'whatsapp', 'hand', 'courier', 'portal') then
    raise exception 'Choose how it was delivered. Nothing has been recorded.';
  end if;
  if v_on > current_date then raise exception 'The delivery date is in the future. Nothing has been recorded.'; end if;
  insert into public.invoice_deliveries (invoice_id, company_id, delivered_on, method, note)
  values (p_invoice_id, v_company, v_on, p_method, nullif(btrim(p_note), ''))
  on conflict (invoice_id) do update set delivered_on = excluded.delivered_on, method = excluded.method, note = excluded.note,
                                         marked_by = auth.uid(), marked_at = now();
end $$;

create or replace function public.unmark_invoice_delivered(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_branch uuid; v_n int;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_invoice_id via public.invoices
  if p_invoice_id is not null then perform public.assert_same_company((select company_id from public.invoices where id = p_invoice_id)); end if;
  select c.branch_id into v_branch from public.invoices i join public.clients c on c.id = i.client_id where i.id = p_invoice_id;
  perform public.assert_branch_writable(v_branch);
  delete from public.invoice_deliveries where invoice_id = p_invoice_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'That invoice was not marked delivered. Nothing has been changed.'; end if;
end $$;

-- ───────────────────────── 2. Missing invoices ─────────────────────────
-- Clients with a contract running during the month and no invoice billing that
-- month. Read by anyone who can read invoices (invoker over invoices/clients).
create or replace function public.invoices_missing(p_month date)
returns table (client_id uuid, client_name text, branch_id uuid, contract_code text, guards int)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.name, c.branch_id, min(k.contract_code), sum(coalesce(k.number_of_guards, 0))::int
    from public.clients c
    join public.contracts k on k.client_id = c.id
   where c.company_id = public.current_company_id()
     and c.merged_into is null
     and k.status::text = 'active'
     and k.start_date <= (date_trunc('month', p_month) + interval '1 month - 1 day')::date
     and (k.end_date is null or k.end_date >= date_trunc('month', p_month)::date)
     and not exists (select 1 from public.invoices i
                      where i.client_id = c.id
                        and coalesce(i.service_month, date_trunc('month', i.period_start)::date) = date_trunc('month', p_month)::date)
   group by c.id, c.name, c.branch_id
   order by c.name
$$;
comment on function public.invoices_missing(date) is
  '0632: clients with an active contract running in the month and no invoice billing that month. Invoker: RLS on invoices decides who can call it usefully.';
grant execute on function public.invoices_missing(date) to authenticated;

-- ───────────────────────── 3. Report runs: "since the last report" ─────────────────────────
create table public.report_runs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  report_kind  text not null check (report_kind in ('finance', 'hr', 'ops')),
  period_from  timestamptz not null,
  period_to    timestamptz not null check (period_to >= period_from),
  exported_by  uuid default auth.uid(),
  exported_at  timestamptz not null default now()
);
create index report_runs_kind_idx on public.report_runs (company_id, report_kind, period_to desc);
comment on table public.report_runs is
  '0632: each export of a report and the period it covered. The next report of that kind starts at the latest period_to, so everything entered since is covered once. Written by log_report_run().';
alter table public.report_runs enable row level security;
create policy company_members on public.report_runs for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.report_runs for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_write_ins on public.report_runs as restrictive for insert with check (false);
create policy perm_write_upd on public.report_runs as restrictive for update using (false) with check (false);
create policy perm_write_del on public.report_runs as restrictive for delete using (false);
grant select on public.report_runs to authenticated;

-- Who may read the finance report: anyone who can see receivable amounts, or
-- reports.view, or the CEO dashboard.
create or replace function public.can_read_finance_report()
returns boolean language sql stable security invoker set search_path = public as $$
  select public.can_see_receivable_amounts() or public.has_perm('reports.view') or public.has_perm('dashboard.ceo')
$$;
create or replace function public.can_read_hr_report()
returns boolean language sql stable security invoker set search_path = public as $$
  select public.has_perm('attendance.view') or public.has_perm('employees.view') or public.has_perm('reports.view') or public.has_perm('dashboard.ceo')
$$;
grant execute on function public.can_read_finance_report() to authenticated;
grant execute on function public.can_read_hr_report() to authenticated;

-- Where the next report of this kind starts: the end of the last one, else 24 hours ago.
create or replace function public.report_period_start(p_kind text)
returns timestamptz
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((select max(r.period_to) from public.report_runs r
                    where r.company_id = public.current_company_id() and r.report_kind = p_kind),
                  now() - interval '1 day')
$$;
grant execute on function public.report_period_start(text) to authenticated;

create or replace function public.log_report_run(p_kind text, p_from timestamptz, p_to timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind = 'finance' and not public.can_read_finance_report() then raise exception 'Your login cannot export the finance report.' using errcode = '42501'; end if;
  if p_kind = 'hr' and not public.can_read_hr_report() then raise exception 'Your login cannot export the attendance report.' using errcode = '42501'; end if;
  if p_kind = 'ops' and not (public.has_perm('roster.view') or public.has_perm('roster.edit') or public.has_perm('incidents.view') or public.has_perm('dashboard.ceo')) then
    raise exception 'Your login cannot export the daily report.' using errcode = '42501';
  end if;
  if p_kind not in ('finance', 'hr', 'ops') or p_from is null or p_to is null or p_to < p_from then
    raise exception 'That report period is not valid. Nothing has been recorded.';
  end if;
  insert into public.report_runs (company_id, report_kind, period_from, period_to) values (public.current_company_id(), p_kind, p_from, least(p_to, now()));
end $$;
comment on function public.log_report_run(text, timestamptz, timestamptz) is
  '0632: record an exported report''s period, so the next one starts where it ended. Gate: the report''s own read permission.';

-- ───────────────────────── 4. Finance report ─────────────────────────
create or replace function public.finance_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_co      uuid := public.current_company_id();
  v_branch  uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
  v_month   date := (date_trunc('month', current_date) - interval '1 month')::date;  -- the month just billed
  v_pay     date;
  r         jsonb;
begin
  -- Stated here as well as in can_read_finance_report(): security_gaps() reads
  -- this body for the permission check of a definer function that touches money.
  if not (public.can_see_receivable_amounts() or public.has_perm('reports.view') or public.has_perm('dashboard.ceo')) then
    raise exception 'Your login needs a finance permission (or "View the CEO dashboard") for the finance report.' using errcode = '42501';
  end if;
  select max(period_month) into v_pay from public.payslips where company_id = v_co;

  r := jsonb_build_object(
    'from', p_from, 'to', p_to, 'billing_month', v_month, 'payroll_month', v_pay,

    -- Invoices ENTERED in the period.
    'invoices_raised', coalesce((select jsonb_agg(jsonb_build_object(
        'invoice_id', i.id, 'client', c.name, 'branch_id', c.branch_id, 'number', i.invoice_number, 'invoice_date', i.invoice_date,
        'for_month', coalesce(i.service_month, date_trunc('month', i.period_start)::date), 'amount', i.invoice_amount,
        'auto', coalesce(i.generated, false), 'delivered', d.invoice_id is not null) order by c.name, i.invoice_date)
      from public.invoices i join public.clients c on c.id = i.client_id left join public.invoice_deliveries d on d.invoice_id = i.id
      where i.company_id = v_co and i.created_at >= p_from and i.created_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),

    -- Invoices MARKED delivered in the period.
    'invoices_delivered', coalesce((select jsonb_agg(jsonb_build_object(
        'client', c.name, 'branch_id', c.branch_id, 'number', i.invoice_number, 'amount', i.invoice_amount,
        'method', d.method, 'delivered_on', d.delivered_on) order by d.delivered_on, c.name)
      from public.invoice_deliveries d join public.invoices i on i.id = d.invoice_id join public.clients c on c.id = i.client_id
      where d.company_id = v_co and d.marked_at >= p_from and d.marked_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),

    -- Open: invoices of the last two billing months not yet delivered (a state, not period-bound).
    'undelivered', coalesce((select jsonb_agg(jsonb_build_object(
        'invoice_id', i.id, 'client', c.name, 'branch_id', c.branch_id, 'number', i.invoice_number, 'invoice_date', i.invoice_date,
        'for_month', coalesce(i.service_month, date_trunc('month', i.period_start)::date), 'amount', i.invoice_amount, 'auto', coalesce(i.generated, false)) order by i.invoice_date, c.name)
      from public.invoices i join public.clients c on c.id = i.client_id
      where i.company_id = v_co and not exists (select 1 from public.invoice_deliveries d where d.invoice_id = i.id)
        and coalesce(i.service_month, date_trunc('month', i.period_start)::date) >= (v_month - interval '1 month')::date
        and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),

    'missing', coalesce((select jsonb_agg(jsonb_build_object('client', m.client_name, 'branch_id', m.branch_id, 'guards', m.guards) order by m.client_name)
      from public.invoices_missing(v_month) m where v_branch is null or m.branch_id = v_branch), '[]'::jsonb),

    -- Payments ENTERED in the period (one line per payment row; the screen groups nothing).
    'receipts', coalesce((select jsonb_agg(jsonb_build_object(
        'client', c.name, 'branch_id', c.branch_id, 'payment_date', p.payment_date,
        'mode', case when p.cheque_id is not null then 'Cheque' else p.payment_mode end,
        'to', coalesce((select b.bank_name || coalesce(' ••' || right(regexp_replace(b.account_number, '\D', '', 'g'), 4), '') from public.bank_accounts b where b.id = p.bank_account_id),
                       (select 'Cash · ' || l.name from public.cash_locations l where l.id = p.custodian_location_id)),
        'amount', p.amount, 'wht', coalesce(p.withholding_amount, 0), 'invoice', i.invoice_number) order by p.payment_date, c.name)
      from public.invoice_payments p left join public.invoices i on i.id = p.invoice_id
      join public.clients c on c.id = coalesce(p.client_id, i.client_id)
      where p.company_id = v_co and p.created_at >= p_from and p.created_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),

    -- Expenses ENTERED in the period.
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
        'date', e.expense_date, 'category', coalesce(ec.name, e.pl_category::text, 'Uncategorised'), 'description', e.description,
        'amount', e.amount, 'mode', coalesce(e.paid_via, e.payment_mode), 'branch_id', e.branch_id, 'approved', e.approved_at is not null) order by e.expense_date, ec.name)
      from public.expenses e left join public.expense_categories ec on ec.id = e.category_id
      where e.company_id = v_co and e.created_at >= p_from and e.created_at < p_to and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),

    -- Salaries: what was disbursed in the period, and where the latest payroll month stands.
    'salaries_paid', coalesce((select jsonb_agg(jsonb_build_object('month', s.period_month, 'people', s.n, 'paid', s.paid) order by s.period_month)
      from (select ps.period_month, count(*) n, sum(coalesce(ps.amount_paid, ps.net_salary)) paid from public.payslips ps
             where ps.company_id = v_co and ps.disbursed and ps.disbursed_at >= p_from and ps.disbursed_at < p_to and (v_branch is null or ps.branch_id = v_branch)
             group by ps.period_month) s), '[]'::jsonb),
    'payroll_status', (select jsonb_build_object('month', v_pay, 'people', count(*), 'net', sum(ps.net_salary),
                                                 'paid', sum(coalesce(ps.amount_paid, 0)), 'unpaid_people', count(*) filter (where not coalesce(ps.disbursed, false)),
                                                 'remaining', sum(greatest(ps.net_salary - coalesce(ps.amount_paid, 0), 0)))
      from public.payslips ps where ps.company_id = v_co and ps.period_month = v_pay and (v_branch is null or ps.branch_id = v_branch)),

    -- Receivables now, and the follow-up picture.
    'receivables', (select jsonb_build_object('owed', sum(t.balance), 'overdue', sum(t.overdue), 'over_90', sum(t.age_over_90),
                                              'clients_owing', count(*) filter (where t.balance > 0.5), 'wht_awaiting', sum(t.wht_awaiting_certificate))
      from public.client_receivables_base() t where v_branch is null or t.branch_id = v_branch),
    'late_clients', coalesce((select jsonb_agg(jsonb_build_object('client', t.client_name, 'branch_id', t.branch_id, 'owed', t.balance, 'overdue', t.overdue,
                                                                  'last_paid_on', t.last_paid_on, 'last_contact_on', t.last_contact_on, 'promised_by', t.promised_by) order by t.overdue desc)
      from (select * from public.client_receivables_base() b where b.overdue > 0.5 and (v_branch is null or b.branch_id = v_branch) order by b.overdue desc limit 15) t), '[]'::jsonb),
    'followups', coalesce((select jsonb_agg(jsonb_build_object('client', c.name, 'branch_id', c.branch_id, 'on', f.contacted_on, 'channel', f.channel, 'note', f.note,
                                                               'promised_by', f.promised_by, 'next_step', f.next_step) order by f.contacted_on, c.name)
      from public.client_followups f join public.clients c on c.id = f.client_id
      where f.company_id = v_co and f.created_at >= p_from and f.created_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),

    -- Items waiting on someone (states).
    'waiting', jsonb_build_object(
      'write_offs_pending', (select count(*) from public.client_write_offs w join public.clients c on c.id = w.client_id where w.company_id = v_co and w.status = 'pending' and (v_branch is null or c.branch_id = v_branch)),
      'write_offs_approved', coalesce((select jsonb_agg(jsonb_build_object('client', c.name, 'amount', w.amount, 'reason', w.reason))
         from public.client_write_offs w join public.clients c on c.id = w.client_id
         where w.company_id = v_co and w.status = 'approved' and w.decided_at >= p_from and w.decided_at < p_to and (v_branch is null or c.branch_id = v_branch)), '[]'::jsonb),
      'cheques_uncleared', (select count(*) from public.cheques q where q.company_id = v_co and q.direction = 'incoming' and coalesce(q.status, 'pending') not in ('cleared', 'bounced') and (v_branch is null or q.branch_id = v_branch)),
      'field_requests_pending', (select count(*) from public.field_money_requests m where m.company_id = v_co and m.status = 'pending'),
      'certificates_awaiting', (select count(*) from public.invoice_payments p where p.company_id = v_co and p.wht_status = 'claimed'))
  );
  return r;
end $$;
comment on function public.finance_report(timestamptz, timestamptz) is
  '0632 (DECIDED 2 Nov 2026): the finance report — everything ENTERED between p_from and p_to (invoices, deliveries, payments, expenses, salaries disbursed, follow-ups, write-offs) plus the state now (undelivered, missing, payroll remaining, receivables, late clients, items waiting). Gate can_read_finance_report(); company and region scoped here.';

-- ───────────────────────── 5. Staff changes for the attendance report ─────────────────────────
create or replace function public.hr_changes(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_co     uuid := public.current_company_id();
  v_branch uuid := case when public.is_branched_user() and not public.is_super_super_admin() then public.current_branch_id() end;
begin
  if not (public.has_perm('attendance.view') or public.has_perm('employees.view') or public.has_perm('reports.view') or public.has_perm('dashboard.ceo')) then
    raise exception 'Your login needs an attendance or employee permission for staff changes.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'hired', coalesce((select jsonb_agg(jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'category', e.category::text,
                                                           'client', c.name, 'join_date', e.join_date, 'branch_id', e.branch_id) order by e.join_date, e.full_name)
      from public.employees e left join public.clients c on c.id = e.client_id
      where e.company_id = v_co and e.created_at >= p_from and e.created_at < p_to and coalesce(e.lifecycle_state::text, '') <> 'archived'
        and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),
    'separated', coalesce((select jsonb_agg(jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'to_state', l.to_state::text,
                                                               'reason', l.reason, 'last_day', e.last_working_day, 'branch_id', e.branch_id) order by l.changed_at)
      from public.employee_lifecycle_events l join public.employees e on e.id = l.employee_id
      where l.company_id = v_co and l.changed_at >= p_from and l.changed_at < p_to and l.to_state::text in ('left', 'terminated', 'fired', 'absconded')
        and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),
    'rehired', coalesce((select jsonb_agg(jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'join_date', e.join_date, 'branch_id', e.branch_id) order by l.changed_at)
      from public.employee_lifecycle_events l join public.employees e on e.id = l.employee_id
      where l.company_id = v_co and l.changed_at >= p_from and l.changed_at < p_to and l.reason like 'Rehire%'
        and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),
    'transferred', coalesce((select jsonb_agg(jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'to_client', c.name, 'from', d.start_date, 'branch_id', e.branch_id) order by d.start_date)
      from public.deployments d join public.employees e on e.id = d.guard_id join public.clients c on c.id = d.client_id
      where d.company_id = v_co and d.created_at >= p_from and d.created_at < p_to and d.reason::text = 'transfer'
        and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),
    'salary_changes', coalesce((select jsonb_agg(jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'from_date', s.effective_date,
                                                                    'base', s.base_salary, 'reason', coalesce(s.salary_change_reason::text, s.reason), 'branch_id', e.branch_id) order by s.effective_date)
      from public.employee_salary_history s join public.employees e on e.id = s.employee_id
      where s.company_id = v_co and s.created_at >= p_from and s.created_at < p_to and (v_branch is null or e.branch_id = v_branch)), '[]'::jsonb),
    -- Documents running out in the next 30 days, for staff still employed.
    'expiring', coalesce((select jsonb_agg(x order by x->>'date') from (
        select jsonb_build_object('name', e.full_name, 'code', e.employee_code, 'document', d.doc, 'date', d.on_date, 'branch_id', e.branch_id) x
          from public.employees e
          cross join lateral (values ('CNIC', e.cnic_expiry), ('Weapon licence', e.weapon_licence_expiry), ('Guard licence', e.guard_service_licence_expiry),
                                     ('Medical fitness', e.medical_fitness_expiry), ('Weapons certificate', e.weapons_cert_expiry)) d(doc, on_date)
         where e.company_id = v_co and coalesce(e.lifecycle_state::text, 'active') = 'active'
           and d.on_date between current_date and current_date + 30
           and (v_branch is null or e.branch_id = v_branch)) q), '[]'::jsonb)
  );
end $$;
comment on function public.hr_changes(timestamptz, timestamptz) is
  '0632: staff changes ENTERED between p_from and p_to — hired, separated, re-hired, transferred, salary changes — and documents expiring in the next 30 days. Gate can_read_hr_report(); company and region scoped here.';

-- ───────────────────────── 6. People: who did what ─────────────────────────
insert into public.permission_keys (key, grp, label)
values ('dashboard.ceo', 'Reports', 'View the CEO dashboard (every report, live, and what each person did)')
on conflict (key) do nothing;

create or replace function public.people_activity(p_from timestamptz, p_to timestamptz)
returns table (person_id uuid, person_name text, area text, actions int, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.has_perm('dashboard.ceo') then
    raise exception 'Your login needs "View the CEO dashboard" for this.' using errcode = '42501';
  end if;
  return query
  with acts as (
    -- Everything the audit trail saw each login write.
    select a.changed_by as pid, a.table_name as tbl, a.changed_at as at
      from public.audit_log a
     where a.company_id = public.current_company_id() and a.changed_at >= p_from and a.changed_at < p_to and a.changed_by is not null
    union all
    -- Attendance is not audited row by row; its marks carry who marked them.
    select ar.marked_by_user_id, 'attendance_records', ar.marked_at
      from public.attendance_records ar
     where ar.company_id = public.current_company_id() and ar.marked_at >= p_from and ar.marked_at < p_to and ar.marked_by_user_id is not null
    union all
    select f.created_by, 'client_followups', f.created_at
      from public.client_followups f
     where f.company_id = public.current_company_id() and f.created_at >= p_from and f.created_at < p_to and f.created_by is not null
  )
  select p.id, p.full_name,
         case a.tbl
           when 'attendance_records' then 'Attendance marked'
           when 'attendance_confirmations' then 'Attendance confirmed'
           when 'employees' then 'Employee records'
           when 'deployments' then 'Postings and transfers'
           when 'expenses' then 'Expenses'
           when 'invoices' then 'Invoices'
           when 'invoice_payments' then 'Payments received'
           when 'payslips' then 'Payroll'
           when 'bank_transactions' then 'Bank and cash movements'
           when 'daily_client_reports' then 'Daily report notes'
           when 'daily_report_tasks' then 'Daily report tasks'
           when 'daily_report_day_notes' then 'Daily report updates'
           when 'attendance_gap_notes' then 'Attendance explanations'
           when 'client_followups' then 'Payment follow-ups'
           when 'advances' then 'Advances'
           when 'cheques' then 'Cheques'
           when 'clients' then 'Clients'
           when 'contracts' then 'Contracts'
           else 'Other changes'
         end,
         count(*)::int, max(a.at)
    from acts a join public.profiles p on p.id = a.pid
   where p.company_id = public.current_company_id()
   group by p.id, p.full_name, 3
   order by p.full_name, 4 desc;
end $$;
comment on function public.people_activity(timestamptz, timestamptz) is
  '0632 (DECIDED 2 Nov 2026): what each login did between p_from and p_to, counted by area — from the audit trail, attendance marks and follow-ups they already create. Nobody records anything extra. Gate dashboard.ceo.';

revoke all on function public.mark_invoice_delivered(uuid, text, date, text) from public, anon;
revoke all on function public.unmark_invoice_delivered(uuid) from public, anon;
revoke all on function public.log_report_run(text, timestamptz, timestamptz) from public, anon;
revoke all on function public.finance_report(timestamptz, timestamptz) from public, anon;
revoke all on function public.hr_changes(timestamptz, timestamptz) from public, anon;
revoke all on function public.people_activity(timestamptz, timestamptz) from public, anon;
grant execute on function public.mark_invoice_delivered(uuid, text, date, text) to authenticated;
grant execute on function public.unmark_invoice_delivered(uuid) to authenticated;
grant execute on function public.log_report_run(text, timestamptz, timestamptz) to authenticated;
grant execute on function public.finance_report(timestamptz, timestamptz) to authenticated;
grant execute on function public.hr_changes(timestamptz, timestamptz) to authenticated;
grant execute on function public.people_activity(timestamptz, timestamptz) to authenticated;

-- ───────────────────────── 7. Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_inv uuid; v_msg text; v_ran int := 0; v_r jsonb; v_t0 timestamptz := now() - interval '1 second';
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. Delivery: a bad method is refused by message; a good one ticks; untick removes.
    select id into v_inv from public.invoices where invoice_number = 'GGS/HMC/10/26';
    v_msg := null;
    begin perform public.mark_invoice_delivered(v_inv, 'pigeon'); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Choose how it was delivered. Nothing has been recorded.' then raise exception '0632 REFUSED: a bad method got "%".', v_msg; end if;
    perform public.mark_invoice_delivered(v_inv, 'email', current_date, 'to accounts');
    if not exists (select 1 from public.invoice_deliveries where invoice_id = v_inv and method = 'email') then raise exception '0632 REFUSED: the delivery was not recorded.'; end if;
    v_ran := v_ran + 1;

    -- 2. The finance report sees that delivery in its period, and the October invoices as delivered or not.
    v_r := public.finance_report(v_t0, now() + interval '1 second');
    if not exists (select 1 from jsonb_array_elements(v_r -> 'invoices_delivered') x where x ->> 'number' = 'GGS/HMC/10/26') then
      raise exception '0632 REFUSED: the finance report does not show the delivery: %.', v_r -> 'invoices_delivered';
    end if;
    if exists (select 1 from jsonb_array_elements(v_r -> 'undelivered') x where x ->> 'number' = 'GGS/HMC/10/26') then
      raise exception '0632 REFUSED: a delivered invoice is listed as undelivered.';
    end if;
    if not (v_r ? 'payroll_status' and v_r ? 'receivables' and v_r ? 'missing' and v_r ? 'waiting') then raise exception '0632 REFUSED: the finance report is missing a section.'; end if;
    perform public.unmark_invoice_delivered(v_inv);
    if exists (select 1 from public.invoice_deliveries where invoice_id = v_inv) then raise exception '0632 REFUSED: untick did not remove the delivery.'; end if;
    v_ran := v_ran + 1;

    -- 3. Since the last report: a logged run moves the next start to its end.
    perform public.log_report_run('finance', now() - interval '2 days', now() - interval '1 hour');
    if public.report_period_start('finance') <> (select max(period_to) from public.report_runs where report_kind = 'finance') then
      raise exception '0632 REFUSED: the next finance report does not start where the last ended.';
    end if;
    v_ran := v_ran + 1;

    -- 4. HR changes and people activity answer for the boss.
    v_r := public.hr_changes(now() - interval '30 days', now());
    if not (v_r ? 'hired' and v_r ? 'separated' and v_r ? 'transferred' and v_r ? 'expiring') then raise exception '0632 REFUSED: hr_changes is missing a section.'; end if;
    perform * from public.people_activity(now() - interval '7 days', now());
    v_ran := v_ran + 1;

    -- 5. A login with only the follow-up key gets none of them, each refused by message.
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up'] where id = v_hr;
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    v_msg := null; begin perform public.finance_report(now() - interval '1 day', now()); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Your login needs a finance permission (or "View the CEO dashboard") for the finance report.' then raise exception '0632 REFUSED: finance report for ops got "%".', v_msg; end if;
    v_msg := null; begin perform * from public.people_activity(now() - interval '1 day', now()); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Your login needs "View the CEO dashboard" for this.' then raise exception '0632 REFUSED: people activity for ops got "%".', v_msg; end if;
    v_ran := v_ran + 1;

    if v_ran <> 5 then raise exception '0632 REFUSED: % of 5 assertions ran.', v_ran; end if;
    raise exception '0632-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0632-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0632 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0632 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0632 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
