-- 0626 — client receivables read from the database, a client ledger like a
--        bank statement, and withholding certificates recorded once.
--
-- DECIDED by Shayan, 2 Nov 2026 (asked and answered in the Receivables revamp):
--   * The Receivables list opens on BALANCE TODAY — no month picker. Each client:
--     brought forward (before Bastion), what they owe now, how old it is, last
--     payment. "Opening" is no longer used for two different things.
--   * The client ledger runs BY DATE, like a bank statement. An advance invoice
--     (November billed on 2 Nov) sits on its invoice date, with the month it is
--     for beside it. Revenue recognition is untouched (A4: service month); this is
--     what the statement SHOWS, not when revenue counts.
--   * Each payment line shows date and mode, cheque number / status / date, where
--     the money went (our bank account or the person holding the cash), and the
--     tax deducted with its certificate status.
--   * WHT certificates are recorded ONCE per certificate, covering the receipts it
--     names, and the amounts must agree.
--
-- WHY AGEING IS NOT READ OFF invoices.outstanding. Receipts against a client's
-- before-Bastion balance were in places applied to invoices, so some invoices
-- read as overpaid (Bin Zahid −12,000; AlRabi −597,386) while the client's total
-- is right. Ageing therefore allocates the client's TOTAL settled (cash + WHT)
-- oldest first — brought forward first, then invoices by date — and ages what is
-- left. The balance is the same number either way; only the split by age differs,
-- and this split cannot be wrong in the way the per-invoice one is.
--
-- RECEIPTS ARE GROUPED. record_invoice_payment splits one receipt into a row per
-- invoice it settles; cheque_apply_balance writes rows sharing a cheque. The
-- ledger folds them back to one line: rows of one cheque, or rows written in the
-- same call (same created_at, date and mode). Today no receipt is split (62 rows,
-- 62 receipts), so the grouping changes nothing yet; it exists so the next split
-- receipt does not appear as three payments.
--
-- READS ARE SECURITY INVOKER. Both read functions run as the caller, so the
-- table's own RLS (company, branch, perm_read) decides what they see. A hidden row
-- makes a statement smaller, which for a READ is the same thing the table itself
-- would show — there is no write to under-perform.

-- ───────────────────────── 1. Balance today, per client ─────────────────────────
create or replace function public.client_receivables_today()
returns table (
  client_id        uuid,
  client_name      text,
  branch_id        uuid,
  brought_forward  numeric,
  invoiced         numeric,
  settled          numeric,
  cash_received    numeric,
  wht_deducted     numeric,
  balance          numeric,
  owed_before_bastion numeric,
  age_0_30         numeric,
  age_31_60        numeric,
  age_61_90        numeric,
  age_over_90      numeric,
  open_invoices    int,
  oldest_open_date date,
  wht_awaiting_certificate numeric,
  last_paid_on     date,
  last_paid_mode   text,
  last_paid_amount numeric
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
    select cid,
           sum(cash + wht) as settled,
           sum(cash) as cash,
           sum(wht) as wht
      from rcp group by cid
  ),
  -- Legacy receipts no invoice_payments row explains (amount_received above what
  -- the rows add up to). Counted as settled, dated at the invoice. Zero today.
  untracked as (
    select i.client_id as cid,
           sum(greatest(0, i.amount_received
                 - coalesce((select sum(p.amount + coalesce(p.withholding_amount, 0))
                               from public.invoice_payments p where p.invoice_id = i.id), 0))) as amt
      from public.invoices i group by 1
  ),
  last_rcp as (
    select distinct on (cid) cid, d, mode, cash + wht as amt
      from rcp order by cid, d desc, gk desc
  ),
  pending_wht as (
    select cid, sum(coalesce(withholding_amount, 0)) as amt
      from pay where wht_status = 'claimed' group by cid
  ),
  -- Everything the client was charged, oldest first: brought forward, then invoices.
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
           coalesce(pd.settled, 0) + coalesce(u.amt, 0) as paid_total
      from items it
      left join paid pd on pd.cid = it.cid
      left join untracked u on u.cid = it.cid
  ),
  left_over as (
    select cid, ord, d,
           greatest(0, least(amt, cum - paid_total)) as remaining
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
         coalesce(c.opening_balance, 0)
           + coalesce((select sum(i.invoice_amount) from public.invoices i where i.client_id = c.id), 0)
           - coalesce(pd.settled, 0) - coalesce(u.amt, 0),
         coalesce(a.bf_left, 0),
         coalesce(a.a0, 0),
         coalesce(a.a31, 0),
         coalesce(a.a61, 0),
         coalesce(a.a90, 0),
         coalesce(a.n_open, 0),
         a.oldest,
         coalesce(pw.amt, 0),
         lr.d,
         lr.mode,
         lr.amt
    from public.clients c
    left join paid pd on pd.cid = c.id
    left join untracked u on u.cid = c.id
    left join ages a on a.cid = c.id
    left join pending_wht pw on pw.cid = c.id
    left join last_rcp lr on lr.cid = c.id
   where c.company_id = public.current_company_id()
     and c.name !~* '\(merged into '
$$;

comment on function public.client_receivables_today() is
  '0626 (DECIDED 2 Nov 2026): the Receivables list — per client, balance today = brought forward + invoiced − settled (cash + WHT, A1), split by age with receipts applied oldest first (brought forward, then invoices by date). Invoker: RLS decides which clients the caller sees. The age columns plus owed_before_bastion add up to balance whenever balance ≥ 0; a negative balance is the client in credit and every age column is 0.';

-- ───────────────────────── 2. The client ledger ─────────────────────────
create or replace function public.client_receivable_ledger(p_client_id uuid, p_from date default null, p_to date default null)
returns table (
  line_no          int,
  line_date        date,
  line_kind        text,      -- opening | invoice | receipt | untracked
  reference        text,
  for_month        date,
  details          text,
  mode             text,      -- Cash | Bank | Cheque
  cheque_no        text,
  cheque_status    text,      -- pending | cleared | bounced
  cheque_status_on date,
  deposited_to     text,
  invoiced         numeric,
  received         numeric,   -- cash that arrived
  wht              numeric,   -- tax the client deducted (clears the receivable with the cash, A1)
  wht_status       text,      -- awaiting certificate | certificate received | not deposited
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
           bool_or(p.wht_status = 'claimed') as any_claimed,
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
           i.invoice_amount as inv, 0::numeric as cash, 0::numeric as wht,
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
           0, r.cash, r.wht,
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
           null, null, null, null, 'Not recorded', 0, u.amt, 0, null, null, null, u.id
      from untracked u where u.amt > 0.005
  ),
  opening as (
    select (select bf from c)
           + coalesce(sum(inv - cash - wht) filter (where p_from is not null and d < p_from), 0) as amt
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
         null, null, null, null, null, 0::numeric, 0::numeric, 0::numeric, null, null,
         (select amt from opening), null::uuid[], null::uuid
   where exists (select 1 from c)
  union all
  select n::int, d, kind, ref, for_month, details, mode, cheque_no, cheque_status, cheque_status_on, deposited_to,
         inv, cash, wht, wht_status, cert,
         (select amt from opening) + sum(inv - cash - wht) over (order by n),
         ids, invoice_id
    from numbered
   order by 1
$$;

comment on function public.client_receivable_ledger(uuid, date, date) is
  '0626 (DECIDED 2 Nov 2026): one client''s receivable as a statement, by DATE — invoices on their invoice date (with the month they bill for), each receipt as ONE line (split rows folded back by cheque or by the call that wrote them) with mode, cheque, destination, cash and WHT; running balance. Line 0 is the opening: "Brought forward" (before Bastion) with no start date, otherwise the balance carried to p_from. With no dates its last balance equals client_receivables_today().balance — asserted by 0626.';

-- ───────────────────────── 3. WHT certificates ─────────────────────────
create table if not exists public.wht_certificates (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  client_id        uuid not null references public.clients(id),
  certificate_no   text not null,
  certificate_date date not null,
  amount           numeric(14,2) not null check (amount > 0),
  attachment_path  text,
  notes            text,
  recorded_by      uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  unique (company_id, client_id, certificate_no)
);

comment on table public.wht_certificates is
  'DECIDED 2 Nov 2026 (0626): a withholding tax certificate (or CPR) from a client, recorded ONCE and linked to the receipts it covers (invoice_payments.wht_certificate_id). No money moves: the tax already cleared the receivable when the receipt was recorded (A1); this records the evidence. Written only by record_wht_certificate(), which requires the certificate''s amount to equal the WHT on the receipts it names.';

alter table public.wht_certificates enable row level security;

create policy company_members on public.wht_certificates for all
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.wht_certificates for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.wht_certificates as restrictive for select
  using ((select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit'))
      or (select public.has_perm('receivables.view')) or (select public.has_perm('accounting.edit'))
      or (select public.has_perm('accountant.view')));
create policy perm_write_ins on public.wht_certificates as restrictive for insert with check (false);
create policy perm_write_upd on public.wht_certificates as restrictive for update using (false) with check (false);
create policy perm_write_del on public.wht_certificates as restrictive for delete using (false);
create policy branch_scope on public.wht_certificates as restrictive for all
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = wht_certificates.client_id and c.branch_id = (select public.current_branch_id())))
  with check ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c where c.id = wht_certificates.client_id and c.branch_id = (select public.current_branch_id())));

grant select on public.wht_certificates to authenticated;

alter table public.invoice_payments
  add column if not exists wht_certificate_id uuid references public.wht_certificates(id);
create index if not exists invoice_payments_wht_certificate_idx on public.invoice_payments (wht_certificate_id);

-- Records a certificate against the receipts it covers. The receipts are named
-- by id (not chosen by a predicate) and every one must be updated, so a receipt
-- the caller cannot reach is a REFUSAL, never a quietly smaller certificate.
create or replace function public.record_wht_certificate(
  p_client_id        uuid,
  p_certificate_no   text,
  p_certificate_date date,
  p_amount           numeric,
  p_payment_ids      uuid[],
  p_attachment_path  text default null,
  p_notes            text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_branch  uuid;
  v_n       int;
  v_wht     numeric;
  v_bad     int;
  v_id      uuid;
begin
  perform public.require_perm('invoices.edit');
  -- tenant guard [resolved]: owning company from p_client_id via public.clients
  if p_client_id is not null then perform public.assert_same_company((select company_id from public.clients where id = p_client_id)); end if;

  select company_id, branch_id into v_company, v_branch from public.clients where id = p_client_id;
  if v_company is null then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
  if v_branch is null and public.is_branched_user() and not public.is_super_super_admin() then
    raise exception 'You are assigned to one region and this client belongs to none. Nothing has been recorded.' using errcode = '42501';
  end if;
  perform public.assert_branch_writable(v_branch);

  if nullif(btrim(p_certificate_no), '') is null then raise exception 'Enter the certificate or CPR number. Nothing has been recorded.'; end if;
  if p_certificate_date is null then raise exception 'Enter the certificate date. Nothing has been recorded.'; end if;
  if p_certificate_date > current_date then raise exception 'The certificate date is in the future. Nothing has been recorded.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount on the certificate. Nothing has been recorded.'; end if;
  if p_payment_ids is null or cardinality(p_payment_ids) = 0 then
    raise exception 'Tick the payments this certificate covers. Nothing has been recorded.';
  end if;
  if exists (select 1 from public.wht_certificates where company_id = v_company and client_id = p_client_id and certificate_no = btrim(p_certificate_no)) then
    raise exception 'Certificate % is already recorded for this client. Nothing has been recorded.', btrim(p_certificate_no);
  end if;

  select count(*) filter (where coalesce(p.client_id, i.client_id) is distinct from p_client_id
                             or p.wht_status is distinct from 'claimed'
                             or coalesce(p.withholding_amount, 0) <= 0),
         coalesce(sum(p.withholding_amount), 0), count(*)
    into v_bad, v_wht, v_n
    from public.invoice_payments p
    left join public.invoices i on i.id = p.invoice_id
   where p.id = any (p_payment_ids);
  if v_n <> cardinality(p_payment_ids) then
    raise exception 'Some of those payments could not be found. Nothing has been recorded.';
  end if;
  if v_bad > 0 then
    raise exception 'Only this client''s payments with tax awaiting a certificate can be covered. Nothing has been recorded.';
  end if;
  if abs(v_wht - p_amount) > 0.5 then
    raise exception 'The certificate is for % but the ticked payments deducted %. Tick the payments it covers, or check the amount. Nothing has been recorded.',
      to_char(p_amount, 'FM999,999,999,990.00'), to_char(v_wht, 'FM999,999,999,990.00');
  end if;

  insert into public.wht_certificates (company_id, client_id, certificate_no, certificate_date, amount, attachment_path, notes)
  values (v_company, p_client_id, btrim(p_certificate_no), p_certificate_date, p_amount, nullif(btrim(p_attachment_path), ''), nullif(btrim(p_notes), ''))
  returning id into v_id;

  perform set_config('app.wht_transition', '1', true);
  update public.invoice_payments
     set wht_status = 'verified', wht_certificate_no = btrim(p_certificate_no), wht_verified_on = p_certificate_date,
         wht_certificate_id = v_id, wht_status_by = auth.uid(), wht_status_at = now(),
         wht_status_note = nullif(btrim(p_notes), '')
   where id = any (p_payment_ids) and wht_status = 'claimed';
  get diagnostics v_n = row_count;
  perform set_config('app.wht_transition', '', true);
  if v_n <> cardinality(p_payment_ids) then
    raise exception 'Expected to mark % payments, marked %. Nothing has been recorded.', cardinality(p_payment_ids), v_n;
  end if;
  return v_id;
end $$;

comment on function public.record_wht_certificate(uuid, text, date, numeric, uuid[], text, text) is
  '0626: record a WHT certificate once and mark the receipts it covers verified. Gate invoices.edit (the same act as verify_wht, for several receipts at once). Receipts named by id, all must be this client''s claimed WHT, and their WHT must equal the certificate to 0.50 — a refusal, not a partial certificate.';

revoke all on function public.record_wht_certificate(uuid, text, date, numeric, uuid[], text, text) from public, anon;
grant execute on function public.record_wht_certificate(uuid, text, date, numeric, uuid[], text, text) to authenticated;
grant execute on function public.client_receivables_today() to authenticated;
grant execute on function public.client_receivable_ledger(uuid, date, date) to authenticated;

-- ───────────────────────── 4. WHT deducted by month (for filing) ─────────────────────────
create or replace view public.wht_deducted_by_month with (security_invoker = true) as
select p.company_id,
       date_trunc('month', p.payment_date)::date as month,
       coalesce(p.client_id, i.client_id) as client_id,
       c.name as client_name,
       sum(p.withholding_amount) as deducted,
       coalesce(sum(p.withholding_amount) filter (where p.wht_status = 'verified'), 0) as certified,
       coalesce(sum(p.withholding_amount) filter (where p.wht_status = 'claimed'), 0) as awaiting,
       count(*) filter (where p.wht_status = 'claimed') as receipts_awaiting
  from public.invoice_payments p
  left join public.invoices i on i.id = p.invoice_id
  left join public.clients c on c.id = coalesce(p.client_id, i.client_id)
 where coalesce(p.withholding_amount, 0) > 0
 group by 1, 2, 3, 4;

comment on view public.wht_deducted_by_month is
  '0626: tax clients deducted, by payment month and client — the figure for filing, with how much is backed by a certificate. Invoker: RLS on invoice_payments applies.';
grant select on public.wht_deducted_by_month to authenticated;

-- ───────────────────────── 5. Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_bank uuid; v_client uuid; v_inv uuid; v_msg text; v_ran int := 0; v_bad text;
  v_pay uuid[]; v_cert uuid; r record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. Every client: the ledger's closing equals today's balance, and the age
    --    columns add up to it (or the client is in credit with every column 0).
    select string_agg(t.client_name || ' ' || t.balance || ' vs ' || coalesce(l.balance, -1), '; ') into v_bad
      from public.client_receivables_today() t
      left join lateral (select x.balance from public.client_receivable_ledger(t.client_id) x order by x.line_no desc limit 1) l on true
     where abs(t.balance - coalesce(l.balance, 0)) > 0.01;
    if v_bad is not null then raise exception '0626 REFUSED: ledger closing differs from today''s balance: %', v_bad; end if;
    v_ran := v_ran + 1;

    select string_agg(client_name, ', ') into v_bad from public.client_receivables_today()
     where (balance >= 0 and abs(balance - (owed_before_bastion + age_0_30 + age_31_60 + age_61_90 + age_over_90)) > 0.01)
        or (balance < 0 and (owed_before_bastion + age_0_30 + age_31_60 + age_61_90 + age_over_90) <> 0);
    if v_bad is not null then raise exception '0626 REFUSED: age columns do not add up to the balance for: %', v_bad; end if;
    v_ran := v_ran + 1;

    -- 2. A dated statement opens at the balance carried to its start.
    select x.client_id into v_client from public.client_receivables_today() x where x.client_name = 'Dolmen City';
    if (select balance from public.client_receivable_ledger(v_client, '2026-10-15') where line_no = 0)
       <> (select l.balance from public.client_receivable_ledger(v_client, null, '2026-10-14') l order by l.line_no desc limit 1) then
      raise exception '0626 REFUSED: a statement from 15 Oct does not open at the balance on 14 Oct.';
    end if;
    v_ran := v_ran + 1;

    -- 3. A receipt with tax: one ledger line with cash and WHT, awaiting a certificate.
    select id into v_bank from public.bank_accounts where company_id = v_co and owner_type = 'company' and coalesce(active, true) limit 1;
    insert into public.clients (company_id, name, branch_id) values (v_co, '0626 test client', '87c67763-e53c-4e0c-8362-38cd8abe4bb2') returning id into v_client;
    insert into public.invoices (company_id, client_id, invoice_number, invoice_date, period_start, period_end, invoice_amount, subtotal, total_due, amount_received, status, total_only)
    values (v_co, v_client, '0626-T-1', current_date, date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
            100000, 100000, 100000, 0, 'Unpaid', true) returning id into v_inv;
    perform public.record_invoice_payment(v_inv, 90000, current_date, 'Bank', v_bank, 'test', 10000, null, null);
    select * into r from public.client_receivable_ledger(v_client) where line_kind = 'receipt';
    if r.received <> 90000 or r.wht <> 10000 or r.balance <> 0 or r.wht_status <> 'awaiting certificate' or r.mode <> 'Bank' or r.deposited_to is null then
      raise exception '0626 REFUSED: the receipt line reads %.', row_to_json(r);
    end if;
    v_pay := r.payment_ids;
    v_ran := v_ran + 1;

    -- 4. A certificate whose amount disagrees is refused, by message.
    v_msg := null;
    begin perform public.record_wht_certificate(v_client, 'CPR-1', current_date, 9000, v_pay); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg not like 'The certificate is for 9,000.00 but the ticked payments deducted 10,000.00.%' then
      raise exception '0626 REFUSED: a wrong certificate amount got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    -- 5. The right amount records once and marks the receipt; a second time is refused.
    v_cert := public.record_wht_certificate(v_client, 'CPR-1', current_date, 10000, v_pay);
    select * into r from public.client_receivable_ledger(v_client) where line_kind = 'receipt';
    if r.wht_status <> 'certificate received' or r.wht_certificate <> 'CPR-1'
       or not exists (select 1 from public.invoice_payments where id = v_pay[1] and wht_certificate_id = v_cert and wht_status = 'verified') then
      raise exception '0626 REFUSED: after the certificate the receipt reads %.', row_to_json(r);
    end if;
    v_msg := null;
    begin perform public.record_wht_certificate(v_client, 'CPR-2', current_date, 10000, v_pay); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Only this client''s payments with tax awaiting a certificate can be covered. Nothing has been recorded.' then
      raise exception '0626 REFUSED: covering a certified receipt again got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    -- 6. The certificate table refuses a hand-written row from a login (run as
    --    the authenticated role: the migration's own role bypasses RLS).
    v_msg := null;
    begin
      execute 'set local role authenticated';
      insert into public.wht_certificates (company_id, client_id, certificate_no, certificate_date, amount) values (v_co, v_client, 'X', current_date, 1);
      execute 'reset role';
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is null or not (v_msg like 'new row violates row-level security policy%' or v_msg like 'permission denied for table wht_certificates%') then
      raise exception '0626 REFUSED: a direct insert got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    if v_ran <> 7 then raise exception '0626 REFUSED: % of 7 assertions ran.', v_ran; end if;
    raise exception '0626-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0626-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0626 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0626 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0626 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $test$;
