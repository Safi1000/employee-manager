-- 0549 — sales tax is filed per client and paid in one challan
--
-- DECIDED 2026-10-22 (Shayan), in his words where they settle something:
--   * Authorities: PRA, FBR (ICT) and AJK. "i will classify each client
--     manually and not all clients are taxable" — Islamabad clients to ICT
--     (FBR), Rawalpindi to PRA; a client with no authority is not taxable.
--   * "the taxable portion is given by us manually" — e.g. FBR at 15% on
--     Emaar's taxable 35,000 is 5,250, and that 5,250 "should land to emaar's
--     specific profitability".
--   * The return runs from the 16th of one month to the 15th of the next and
--     is due on the 15th; money received ON the 15th is in the return due that
--     day. "all the payments from 15th to 15th of each month are taxable
--     regardless whichever month they belong to." Only CLIENT receipts are
--     taxable.
--   * "after entering every taxable client the total challan is generated we
--     will match it with actual and pay the whole in one go from bank or
--     whatever mode". A missed month is paid with the next — "the next month
--     we pay double" — so one payment can settle several returns.
--   * The invoices already INCLUDE the tax. Its cost belongs to the client's
--     SERVICE MONTH ("in august") on the profit side, and to the day it was
--     paid on the cash side ("cash flow statement it belongs to sept").
--   * Nothing before this is converted: "current eobi and taxes to remain as
--     is", recording starts with the next return.
--
-- How it is booked:
--   * POSTING a return (once its lines add up to the challan): per line,
--     Dr 4050 Sales Tax on Invoices (a contra-revenue account: the invoice
--     carried the tax, so revenue is the invoice less it — posting rule #1),
--     with the client and the client's region, dated the line's service month;
--     Cr 2400 Sales Tax Payable.
--   * PAYING one or more posted returns: one money movement for the total,
--     Dr 2400, Cr the bank or the custodian, dated the payment.
--   * client_statement_loaded shows each line as a direct cost of its client:
--     at the service month on the accrual basis, at the payment date on cash.
--
-- DEFERRED (asked of no one yet): a nightly ledger check that 2400 equals the
-- posted, unpaid returns. If added, it is one more real_checks row in
-- ledger_checks and a canary bump (see 0402).

-- ── what is taxable ──────────────────────────────────────────────────────────
alter table public.clients add column if not exists sales_tax_authority text;
alter table public.clients drop constraint if exists clients_sales_tax_authority_check;
alter table public.clients add constraint clients_sales_tax_authority_check
  check (sales_tax_authority is null or sales_tax_authority in ('PRA', 'FBR', 'AJK'));
comment on column public.clients.sales_tax_authority is
  'DECIDED 2026-10-22 (0549). Where this client''s sales tax is filed: PRA, FBR (ICT) or AJK. Null: not taxable. '
  'Set by hand per client (Shayan) on the Statutory tab — Islamabad to FBR, Rawalpindi to PRA.';

create table if not exists public.sales_tax_authorities (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  code       text not null check (code in ('PRA', 'FBR', 'AJK')),
  name       text not null,
  rate       numeric check (rate is null or (rate > 0 and rate < 100)),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);
comment on table public.sales_tax_authorities is
  'DECIDED 2026-10-22 (0549). The rate each authority charges, as a percent of the taxable amount entered per client. '
  'All three start empty: "tax rates can be changes annually soo let me add them manually" (Shayan). A return cannot '
  'take a line at no rate; each line keeps the rate it was filed at, so a later change never rewrites an earlier return.';

insert into public.sales_tax_authorities (company_id, code, name, rate)
select c.id, a.code, a.name, a.rate
  from public.companies c
  cross join (values ('PRA', 'Punjab Revenue Authority', null::numeric),
                     ('FBR', 'FBR — Islamabad Capital Territory', null::numeric),
                     ('AJK', 'AJK Revenue Authority', null::numeric)) a(code, name, rate)
on conflict (company_id, code) do nothing;

-- ── the contra-revenue account ───────────────────────────────────────────────
insert into public.chart_of_accounts (company_id, account_code, account_name, account_type, normal_side, system_key, system_account, notes)
select c.company_id, '4050', 'Sales Tax on Invoices', 'revenue', 'debit', 'sales_tax_contra', true,
       '0549. Contra-revenue: the sales tax inside an invoice, filed per client. Invoice revenue less this is revenue earned.'
  from (select distinct company_id from public.chart_of_accounts where system_key = 'sales_tax_payable') c
 where not exists (select 1 from public.chart_of_accounts x where x.company_id = c.company_id and x.system_key = 'sales_tax_contra');

-- ── returns, lines, payments ─────────────────────────────────────────────────
create table if not exists public.sales_tax_payments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id),
  amount                numeric not null check (amount > 0),
  paid_on               date not null,
  paid_via              text not null check (paid_via in ('Bank', 'Cash')),
  bank_account_id       uuid references public.bank_accounts(id),
  custodian_location_id uuid references public.cash_locations(id),
  reference             text,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  check ((paid_via = 'Bank') = (bank_account_id is not null)),
  check ((paid_via = 'Cash') = (custodian_location_id is not null))
);

create table if not exists public.sales_tax_returns (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  authority      text not null check (authority in ('PRA', 'FBR', 'AJK')),
  due_on         date not null check (extract(day from due_on) = 15),
  window_from    date not null,
  window_to      date not null,
  challan_amount numeric check (challan_amount is null or challan_amount >= 0),
  status         text not null default 'draft' check (status in ('draft', 'posted', 'paid')),
  posted_at      timestamptz,
  posted_by      uuid,
  payment_id     uuid references public.sales_tax_payments(id),
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (company_id, authority, due_on),
  check ((status = 'paid') = (payment_id is not null)),
  check (window_to = due_on and window_from = (due_on - interval '1 month')::date + 1)
);
comment on table public.sales_tax_returns is
  'DECIDED 2026-10-22 (0549). One per authority per due date (the 15th). Covers client receipts from the 16th of the '
  'month before through the 15th. draft → posted (lines add up to the challan; journal per line) → paid (one payment, '
  'which may settle several returns — a missed month paid with the next).';

create table if not exists public.sales_tax_return_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  return_id      uuid not null references public.sales_tax_returns(id) on delete cascade,
  client_id      uuid not null references public.clients(id),
  service_month  date not null check (service_month = date_trunc('month', service_month)::date),
  taxable_amount numeric not null check (taxable_amount > 0),
  rate           numeric not null check (rate > 0 and rate < 100),
  tax_amount     numeric not null check (tax_amount >= 0),
  note           text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  unique (return_id, client_id, service_month)
);
comment on table public.sales_tax_return_lines is
  'DECIDED 2026-10-22 (0549). A client''s taxable amount in a return, typed by hand, for the service month the '
  'receipt paid. tax_amount = round(taxable × rate / 100). The cost lands on this client at this service month.';

alter table public.sales_tax_authorities enable row level security;
alter table public.sales_tax_payments enable row level security;
alter table public.sales_tax_returns enable row level security;
alter table public.sales_tax_return_lines enable row level security;
do $rls$
declare t text;
begin
  foreach t in array array['sales_tax_authorities', 'sales_tax_payments', 'sales_tax_returns', 'sales_tax_return_lines'] loop
    execute format('drop policy if exists company_members_read on public.%I', t);
    execute format('create policy company_members_read on public.%I for select using (company_id = (select public.current_company_id()))', t);
    execute format('drop policy if exists ssa_read on public.%I', t);
    execute format('create policy ssa_read on public.%I for select using ((select public.is_ssa_unscoped()))', t);
    execute format('drop trigger if exists trg_zzz_%s_audit on public.%I', t, t);
    execute format('create trigger trg_zzz_%s_audit after insert or delete or update on public.%I for each row execute function public.log_audit_change()', t, t);
  end loop;
end $rls$;
-- Writes go through the functions below only.
revoke insert, update, delete on public.sales_tax_authorities, public.sales_tax_payments,
  public.sales_tax_returns, public.sales_tax_return_lines from anon, authenticated;
grant select on public.sales_tax_authorities, public.sales_tax_payments,
  public.sales_tax_returns, public.sales_tax_return_lines to authenticated;

-- ── functions ────────────────────────────────────────────────────────────────
create or replace function public.set_sales_tax_rate(p_company_id uuid, p_code text, p_rate numeric)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if p_rate is null or p_rate <= 0 or p_rate >= 100 then
    raise exception 'Enter the rate as a percent, more than 0 and less than 100. Nothing has been changed.' using errcode = '23514';
  end if;
  update public.sales_tax_authorities set rate = p_rate, updated_by = auth.uid(), updated_at = now()
   where company_id = p_company_id and code = p_code;
  if not found then
    raise exception 'No sales tax authority %. Nothing has been changed.', coalesce(p_code, '—') using errcode = 'P0001';
  end if;
end $function$;

create or replace function public.open_sales_tax_return(p_company_id uuid, p_authority text, p_due_on date)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if p_authority not in ('PRA', 'FBR', 'AJK') then
    raise exception 'Choose PRA, FBR or AJK. Nothing has been recorded.' using errcode = '22023';
  end if;
  if p_due_on is null or extract(day from p_due_on) <> 15 then
    raise exception 'A sales tax return is due on the 15th. Nothing has been recorded.' using errcode = '22023';
  end if;
  select id into v_id from public.sales_tax_returns
   where company_id = p_company_id and authority = p_authority and due_on = p_due_on;
  if v_id is not null then return v_id; end if;
  insert into public.sales_tax_returns (company_id, authority, due_on, window_from, window_to, created_by)
  values (p_company_id, p_authority, p_due_on, (p_due_on - interval '1 month')::date + 1, p_due_on, auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

create or replace function public.set_sales_tax_return_line(
  p_return_id uuid, p_client_id uuid, p_service_month date, p_taxable_amount numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare r public.sales_tax_returns; c public.clients; v_rate numeric; v_m date := date_trunc('month', p_service_month)::date; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [resolved]: owning company from p_return_id via public.sales_tax_returns
  if p_return_id is not null then perform public.assert_same_company((select company_id from public.sales_tax_returns where id = p_return_id)); end if;
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;

  select * into r from public.sales_tax_returns where id = p_return_id for update;
  if r.id is null then raise exception 'No such return. Nothing has been recorded.' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then
    raise exception 'This return is already %. Unpost it first to change its lines. Nothing has been recorded.', r.status using errcode = 'P0001';
  end if;
  select * into c from public.clients where id = p_client_id;
  if c.id is null or c.company_id <> r.company_id then raise exception 'No such client. Nothing has been recorded.' using errcode = 'P0001'; end if;
  perform public.assert_branch_writable(c.branch_id);
  if c.sales_tax_authority is distinct from r.authority then
    raise exception '% is % — this is the % return. Classify the client first. Nothing has been recorded.',
      c.name, coalesce('filed with ' || c.sales_tax_authority, 'not marked taxable'), r.authority using errcode = 'P0001';
  end if;
  if v_m is null then raise exception 'Say which service month the receipt paid. Nothing has been recorded.' using errcode = '22023'; end if;

  -- An empty amount removes the line.
  if coalesce(p_taxable_amount, 0) = 0 then
    delete from public.sales_tax_return_lines where return_id = r.id and client_id = c.id and service_month = v_m;
    return null;
  end if;
  if p_taxable_amount < 0 then raise exception 'The taxable amount cannot be negative. Nothing has been recorded.' using errcode = '23514'; end if;
  select rate into v_rate from public.sales_tax_authorities where company_id = r.company_id and code = r.authority;
  if v_rate is null then
    raise exception 'Enter the % rate first. Nothing has been recorded.', r.authority using errcode = 'P0001';
  end if;

  insert into public.sales_tax_return_lines (company_id, return_id, client_id, service_month, taxable_amount, rate, tax_amount, note, created_by)
  values (r.company_id, r.id, c.id, v_m, round(p_taxable_amount, 2), v_rate, round(p_taxable_amount * v_rate / 100, 0),
          nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  on conflict (return_id, client_id, service_month) do update
     set taxable_amount = excluded.taxable_amount, rate = excluded.rate, tax_amount = excluded.tax_amount, note = excluded.note
  returning id into v_id;
  return v_id;
end $function$;

create or replace function public.post_sales_tax_return(p_return_id uuid, p_challan_amount numeric)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare r public.sales_tax_returns; l record; v_total numeric; v_n int := 0;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [resolved]: owning company from p_return_id via public.sales_tax_returns
  if p_return_id is not null then perform public.assert_same_company((select company_id from public.sales_tax_returns where id = p_return_id)); end if;

  select * into r from public.sales_tax_returns where id = p_return_id for update;
  if r.id is null then raise exception 'No such return. Nothing has been posted.' using errcode = 'P0001'; end if;
  if r.status <> 'draft' then raise exception 'This return is already %. Nothing has been posted.', r.status using errcode = 'P0001'; end if;
  select coalesce(sum(tax_amount), 0), count(*) into v_total, v_n from public.sales_tax_return_lines where return_id = r.id;
  if v_n = 0 then raise exception 'Add the taxable clients first. Nothing has been posted.' using errcode = 'P0001'; end if;
  if p_challan_amount is null or round(p_challan_amount, 0) <> v_total then
    raise exception 'The lines come to PKR %, the challan says PKR %. Correct whichever is wrong — they must match. Nothing has been posted.',
      to_char(v_total, 'FM999,999,990'), coalesce(to_char(p_challan_amount, 'FM999,999,990'), '—') using errcode = '23514';
  end if;

  v_n := 0;
  for l in
    select x.*, c.name client_name, c.branch_id
      from public.sales_tax_return_lines x join public.clients c on c.id = x.client_id
     where x.return_id = r.id and x.tax_amount > 0
  loop
    perform public.assert_branch_writable(l.branch_id);
    perform public.post_journal(
      r.company_id, l.service_month,
      'Sales tax ' || r.authority || ' · ' || l.client_name || ' · ' || to_char(l.service_month, 'FMMonth YYYY')
        || ' (return due ' || to_char(r.due_on, 'DD Mon YYYY') || ')',
      'sales_tax_return_lines', l.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'sales_tax_contra', 'debit', l.tax_amount, 'credit', 0, 'client_id', l.client_id),
        jsonb_build_object('key', 'sales_tax_payable', 'debit', 0, 'credit', l.tax_amount, 'client_id', l.client_id)),
      l.branch_id);
    v_n := v_n + 1;
  end loop;

  update public.sales_tax_returns
     set status = 'posted', challan_amount = v_total, posted_at = now(), posted_by = auth.uid()
   where id = r.id;
  return jsonb_build_object('return_id', r.id, 'challan', v_total, 'lines_posted', v_n);
end $function$;

create or replace function public.unpost_sales_tax_return(p_return_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare r public.sales_tax_returns; l record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [resolved]: owning company from p_return_id via public.sales_tax_returns
  if p_return_id is not null then perform public.assert_same_company((select company_id from public.sales_tax_returns where id = p_return_id)); end if;
  select * into r from public.sales_tax_returns where id = p_return_id for update;
  if r.id is null or r.status <> 'posted' then
    raise exception 'Only a posted, unpaid return can be unposted. Nothing has been changed.' using errcode = 'P0001';
  end if;
  for l in select x.id, c.branch_id from public.sales_tax_return_lines x join public.clients c on c.id = x.client_id where x.return_id = r.id loop
    perform public.assert_branch_writable(l.branch_id);
    perform public.reverse_journal_for_source(r.company_id, 'sales_tax_return_lines', l.id, current_date);
  end loop;
  update public.sales_tax_returns set status = 'draft', posted_at = null, posted_by = null where id = r.id;
end $function$;

create or replace function public.pay_sales_tax_returns(
  p_company_id uuid, p_return_ids uuid[], p_paid_via text, p_bank_account_id uuid default null,
  p_custodian_location_id uuid default null, p_paid_on date default null, p_reference text default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_paid_on date := coalesce(p_paid_on, current_date);
  v_total numeric; v_n int; v_label text; v_pay public.sales_tax_payments; v_branch uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  -- tenant guard [resolved]: owning company of p_bank_account_id via public.bank_accounts
  if p_bank_account_id is not null then perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id)); end if;
  -- tenant guard [resolved]: owning company of p_custodian_location_id via public.cash_locations
  if p_custodian_location_id is not null then perform public.assert_same_company((select company_id from public.cash_locations where id = p_custodian_location_id)); end if;

  if p_paid_via not in ('Bank', 'Cash') then
    raise exception 'Sales tax is paid by Bank or Cash. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if p_paid_via = 'Bank' and p_bank_account_id is null then raise exception 'Choose the bank account. Nothing has been recorded.' using errcode = 'P0001'; end if;
  if p_paid_via = 'Cash' and p_custodian_location_id is null then raise exception 'Choose who paid it in cash. Nothing has been recorded.' using errcode = 'P0001'; end if;
  if v_paid_on > current_date then raise exception 'A payment cannot be dated in the future. Nothing has been recorded.' using errcode = '23514'; end if;
  if coalesce(array_length(p_return_ids, 1), 0) = 0 then raise exception 'Choose the returns this payment settles. Nothing has been recorded.' using errcode = 'P0001'; end if;

  perform 1 from public.sales_tax_returns where id = any(p_return_ids) for update;
  select count(*), coalesce(sum(challan_amount), 0),
         string_agg(authority || ' ' || to_char(due_on, 'DD Mon'), ', ' order by due_on, authority)
    into v_n, v_total, v_label
    from public.sales_tax_returns
   where id = any(p_return_ids) and company_id = p_company_id and status = 'posted';
  if v_n <> (select count(distinct x) from unnest(p_return_ids) x) then
    raise exception 'Every return paid must be posted, unpaid, and this company''s. Nothing has been recorded.' using errcode = 'P0001';
  end if;
  if v_total <= 0 then raise exception 'These returns come to nothing. Nothing has been recorded.' using errcode = '23514'; end if;

  v_branch := public.head_office_region(p_company_id);
  perform public.assert_branch_writable(v_branch);

  insert into public.sales_tax_payments (company_id, amount, paid_on, paid_via, bank_account_id, custodian_location_id, reference, created_by)
  values (p_company_id, v_total, v_paid_on, p_paid_via,
          case when p_paid_via = 'Bank' then p_bank_account_id end,
          case when p_paid_via = 'Cash' then p_custodian_location_id end,
          nullif(btrim(coalesce(p_reference, '')), ''), auth.uid())
  returning * into v_pay;

  update public.sales_tax_returns set status = 'paid', payment_id = v_pay.id where id = any(p_return_ids);

  perform public.post_journal(
    p_company_id, v_paid_on, 'Sales tax paid · ' || v_label || coalesce(' · ' || v_pay.reference, ''),
    'sales_tax_payments', v_pay.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'sales_tax_payable', 'debit', v_total, 'credit', 0),
      jsonb_build_object('account_id', public.settlement_account(p_company_id, p_paid_via, v_pay.bank_account_id, v_pay.custodian_location_id, true),
                         'debit', 0, 'credit', v_total)),
    v_branch);

  perform public.apply_money_delta(p_company_id, p_paid_via, v_pay.bank_account_id, -v_total,
    'expense', 'Sales tax paid · ' || v_label, v_pay.id::text);
  return v_pay.id;
end $function$;

do $grants$
declare f text;
begin
  foreach f in array array[
    'set_sales_tax_rate(uuid, text, numeric)', 'open_sales_tax_return(uuid, text, date)',
    'set_sales_tax_return_line(uuid, uuid, date, numeric, text)', 'post_sales_tax_return(uuid, numeric)',
    'unpost_sales_tax_return(uuid)', 'pay_sales_tax_returns(uuid, uuid[], text, uuid, uuid, date, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $grants$;

-- ── client profitability: surgery on the live definition ─────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.client_statement_loaded(date, date, text, uuid)'::regprocedure);
  a1 constant text := E'  exp_client as (\n';
  a2 constant text := E'      select client_id, amt from kit_client\n';
  n int;
begin
  if position('0549 SALES TAX' in v_def) > 0 then return; end if;  -- replay
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0549 REFUSED: anchor 1 appears % times in client_statement_loaded.', n; end if;
  n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if n <> 1 then raise exception '0549 REFUSED: anchor 2 appears % times in client_statement_loaded.', n; end if;
  v_def := replace(v_def, a1,
    E'  -- 0549 SALES TAX filed for this client: a direct cost, at the service month\n' ||
    E'  -- on the accrual basis and on the day the challan was paid on cash.\n' ||
    E'  sales_tax_client as (\n' ||
    E'    select l.client_id, sum(l.tax_amount) as amt\n' ||
    E'      from public.sales_tax_return_lines l\n' ||
    E'      join public.sales_tax_returns r on r.id = l.return_id\n' ||
    E'      left join public.sales_tax_payments sp on sp.id = r.payment_id\n' ||
    E'     cross join cid cross join cash\n' ||
    E'     where l.company_id = cid.company_id and r.status in (''posted'', ''paid'')\n' ||
    E'       and (case when cash.on_cash then sp.paid_on else l.service_month end) between p_start and p_end\n' ||
    E'     group by 1\n' ||
    E'  ),\n' || a1);
  v_def := replace(v_def, a2, a2 ||
    E'      union all\n' ||
    E'      select client_id, amt from sales_tax_client\n');
  execute v_def;
end $surgery$;

-- ── asserts, rolled back by a sentinel ───────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_cl uuid; v_cl2 uuid; v_bank uuid; v_ret uuid; v_ret2 uuid; v_pay uuid; v_bal0 numeric; v_bal numeric;
  v_auth_before text[]; v_base numeric; v_base_cash numeric; v_cost numeric; v_cost_cash numeric; v_stp numeric; v_contra numeric;
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name in
      ('set_sales_tax_rate', 'open_sales_tax_return', 'set_sales_tax_return_line', 'post_sales_tax_return', 'unpost_sales_tax_return', 'pay_sales_tax_returns')) then
    raise exception '0549 REFUSED: tenant_guard_gaps names a sales tax function.';
  end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name in
      ('set_sales_tax_rate', 'open_sales_tax_return', 'set_sales_tax_return_line', 'post_sales_tax_return', 'unpost_sales_tax_return', 'pay_sales_tax_returns')) then
    raise exception '0549 REFUSED: branch_guard_gaps names a sales tax function: %',
      (select json_agg(g) from public.branch_guard_gaps() g where g.function_name like '%sales_tax%');
  end if;

  select id into v_cl from public.clients where company_id = v_co and name = 'Emaar DHA ISB';
  select id into v_cl2 from public.clients where company_id = v_co and id <> v_cl and branch_id is not null order by name limit 1;
  select id into v_bank from public.bank_accounts where company_id = v_co order by balance desc limit 1;

  -- Replay: once real returns exist the proof has nothing left to show, and its
  -- dates would meet them.
  if exists (select 1 from public.sales_tax_returns) then
    raise notice '0549: returns already exist — proof skipped on replay.';
    return;
  end if;
  v_auth_before := array[(select sales_tax_authority from public.clients where id = v_cl), (select sales_tax_authority from public.clients where id = v_cl2)];

  begin
    update public.clients set sales_tax_authority = 'FBR' where id in (v_cl, v_cl2);
    perform public.set_sales_tax_rate(v_co, 'FBR', 15);  -- the proof's own rate, rolled back with it
    select balance into v_bal0 from public.bank_accounts where id = v_bank;
    select coalesce(sum(direct_expenses), 0) into v_base from public.client_statement_loaded('2026-08-01', '2026-08-31', 'revenue', v_co) where client_id = v_cl;
    select coalesce(sum(direct_expenses), 0) into v_base_cash from public.client_statement_loaded('2026-10-01', '2026-10-31', 'cash', v_co) where client_id = v_cl;

    -- August return due 15 Sep "missed"; paid with October's — one payment.
    v_ret := public.open_sales_tax_return(v_co, 'FBR', '2026-09-15');
    if v_ret <> public.open_sales_tax_return(v_co, 'FBR', '2026-09-15') then raise exception '0549 REFUSED: opening twice made two returns.'; end if;
    perform public.set_sales_tax_return_line(v_ret, v_cl, '2026-08-01', 35000, 'proof');   -- 5,250
    v_ret2 := public.open_sales_tax_return(v_co, 'FBR', '2026-10-15');
    perform public.set_sales_tax_return_line(v_ret2, v_cl, '2026-09-01', 20000, 'proof');  -- 3,000
    perform public.set_sales_tax_return_line(v_ret2, v_cl2, '2026-09-01', 10001, 'proof'); -- 1,500 (1,500.15 rounds)

    begin
      perform public.post_sales_tax_return(v_ret2, 4400);
      raise exception '0549 REFUSED: a challan that disagreed with the lines was posted.';
    exception when others then
      if sqlerrm not like 'The lines come to PKR 4,500, the challan says PKR 4,400.%' then raise; end if;
    end;
    perform public.post_sales_tax_return(v_ret, 5250);
    perform public.post_sales_tax_return(v_ret2, 4500);

    select coalesce(sum(jl.credit - jl.debit), 0) into v_stp from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.source_table = 'sales_tax_return_lines' and jl.account_id = public.coa_id(v_co, 'sales_tax_payable');
    if v_stp <> 9750 then raise exception '0549 REFUSED: posting credited % to Sales Tax Payable, expected 9,750.', v_stp; end if;
    select coalesce(sum(jl.debit), 0) into v_contra from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
     where je.source_table = 'sales_tax_return_lines' and jl.account_id = public.coa_id(v_co, 'sales_tax_contra')
       and jl.client_id = v_cl and je.entry_date = '2026-08-01';
    if v_contra <> 5250 then raise exception '0549 REFUSED: Emaar''s August line debited % to 4050, expected 5,250 dated 1 Aug.', v_contra; end if;

    begin
      perform public.set_sales_tax_return_line(v_ret, v_cl, '2026-08-01', 1, null);
      raise exception '0549 REFUSED: a posted return took a line.';
    exception when others then
      if sqlerrm not like 'This return is already posted.%' then raise; end if;
    end;

    v_pay := public.pay_sales_tax_returns(v_co, array[v_ret, v_ret2], 'Bank', v_bank, null, '2026-10-15', 'proof');
    select balance into v_bal from public.bank_accounts where id = v_bank;
    if v_bal0 - v_bal <> 9750 then raise exception '0549 REFUSED: the bank moved %, expected 9,750 in one payment.', v_bal0 - v_bal; end if;
    if (select count(*) from public.bank_transactions where reference_id = v_pay::text) <> 1 then
      raise exception '0549 REFUSED: the payment did not log exactly one money line.';
    end if;
    select coalesce(sum(jl.credit - jl.debit), 0) into v_stp from public.journal_lines jl
     where jl.account_id = public.coa_id(v_co, 'sales_tax_payable');
    if v_stp <> 0 then raise exception '0549 REFUSED: Sales Tax Payable holds % after paying both returns.', v_stp; end if;

    -- Emaar's profitability: 5,250 in August (accrual); 8,250 in October (cash, paid 15 Oct).
    select coalesce(sum(direct_expenses), 0) - v_base into v_cost from public.client_statement_loaded('2026-08-01', '2026-08-31', 'revenue', v_co) where client_id = v_cl;
    select coalesce(sum(direct_expenses), 0) - v_base_cash into v_cost_cash from public.client_statement_loaded('2026-10-01', '2026-10-31', 'cash', v_co) where client_id = v_cl;
    if v_cost <> 5250 then raise exception '0549 REFUSED: Emaar''s August accrual cost moved by %, expected 5,250.', v_cost; end if;
    if v_cost_cash <> 8250 then raise exception '0549 REFUSED: Emaar''s October cash cost moved by %, expected 8,250.', v_cost_cash; end if;
    raise exception '0549-SENTINEL';
  exception when others then
    if sqlerrm <> '0549-SENTINEL' then raise; end if;
  end;

  if exists (select 1 from public.sales_tax_returns)
     or v_auth_before is distinct from array[(select sales_tax_authority from public.clients where id = v_cl), (select sales_tax_authority from public.clients where id = v_cl2)] then
    raise exception '0549 REFUSED: the proof survived its rollback.';
  end if;
  raise notice '0549: sales tax proved — lines must match the challan; per-client cost at service month (accrual) and pay date (cash); two returns paid in one movement.';
end $mig$;
