-- 0631 — client history from the monthly invoice sheets (before Bastion), for reference.
--
-- DECIDED by Shayan, 2 Nov 2026: the monthly "Invoice State GGS" sheets
-- (Apr 2024 – Sep 2026, 29 months; there is no Aug 2024 sheet) are kept as a
-- RECORD of each client's history — invoiced, deducted, received, balance,
-- payment date and remark, per month — for reference and analysis only.
--
-- IT MOVES NO MONEY AND IS NOT RECONCILED. Nothing here enters a balance, the
-- ledger, receivables or any check: the before-Bastion position is the
-- brought-forward figure on each client, and that stands. The sheets follow GGS's
-- own conventions (WHT taken at invoice; some "deductions" are salary paid on the
-- client's behalf) and are kept exactly as typed — a blank cell is null, not 0.
--
-- SCOPE (Shayan's answers): ISB/RWP only. Lahore and Kashmir clients are left out
-- (their records are not exact): AlRabi, Berger, Dynamic Equipment, Dysin,
-- Popular Brand, Popular Water Tank, Waheed Shahzad, Mr. Raza (Lahore); Innovative,
-- Lexus Tower, MIU, Tiges (Kashmir); and the former Lahore clients Harris Model
-- Town, Harris Garden Town, Bahria Town LHR and Highpoint (grouped with Harris on
-- the sheets). Clients that left before Bastion are kept under their sheet name
-- with no client_id. "Mr Salaar/Gulrez" is Cambridge exclusive school; 68 HS, PCI
-- and PFM are the one Bastion client 68 HS-PCI-PFM; HMC and CBU (commercial) are
-- HMC Taxila, as Bastion bills them.
--
-- NOVA CITY IS NOT LOADED YET: its site rows on the sheets carry only invoices;
-- its previous balance, receipts and balance are on the sheet's "Total Nova" row,
-- which the extract left out. It is added once those rows are extracted.
--
-- The rows themselves are loaded by 0631a, 0631b and 0631c (in three parts, each
-- checking a digest of exactly the rows it writes). This migration makes the
-- table, its read policy and the payment-timing view.

create table public.client_sheet_history (
  id                 bigint generated always as identity primary key,
  company_id         uuid not null references public.companies(id),
  client_id          uuid references public.clients(id),
  sheet_client       text not null,
  source_name        text not null,
  sheet_month        date not null,
  p_balance          numeric(14,2),
  invoice            numeric(14,2),
  deduction          numeric(14,2),
  deduction_only     numeric(14,2),
  wht_salary         numeric(14,2),
  received           numeric(14,2),
  balance            numeric(14,2),
  received_date      date,
  received_date_text text,
  note               text,
  source_file        text not null,
  source_row         int not null,
  row_hidden         boolean not null default false,
  unique (company_id, source_file, source_row)
);
create index client_sheet_history_client_idx on public.client_sheet_history (client_id, sheet_month);

comment on table public.client_sheet_history is
  'DECIDED 2 Nov 2026 (0631): each client''s month-by-month history from the monthly invoice sheets before Bastion (Apr 2024 – Sep 2026, ISB/RWP), FOR REFERENCE ONLY. Moves no money and is in no balance, ledger, receivable or check; the brought-forward balance stands. Kept exactly as the sheets typed it (blank = null); received_date_text keeps the date as written. client_id is null for clients that left before Bastion. Read by finance keys; written only by migrations.';

alter table public.client_sheet_history enable row level security;
create policy company_members on public.client_sheet_history for all
  using (company_id = (select public.current_company_id())) with check (company_id = (select public.current_company_id()));
create policy ssa_all on public.client_sheet_history for all
  using ((select public.is_ssa_unscoped())) with check ((select public.is_ssa_unscoped()));
create policy perm_read on public.client_sheet_history as restrictive for select
  using ((select public.can_see_receivable_amounts()));
create policy perm_write_ins on public.client_sheet_history as restrictive for insert with check (false);
create policy perm_write_upd on public.client_sheet_history as restrictive for update using (false) with check (false);
create policy perm_write_del on public.client_sheet_history as restrictive for delete using (false);
grant select on public.client_sheet_history to authenticated;

-- How each client has paid, from the dated receipts: the usual day of the month
-- (median) and the usual number of days into the month after the invoiced month.
-- A SUGGESTION for the client's usual pay day on Payment Follow-up; never set
-- automatically.
create view public.client_sheet_pay_timing with (security_invoker = true) as
select h.company_id, h.client_id,
       count(*) as dated_receipts,
       min(h.received_date) as first_dated, max(h.received_date) as last_dated,
       percentile_disc(0.5) within group (order by extract(day from h.received_date)::int) as usual_day,
       percentile_disc(0.5) within group (order by (h.received_date - (h.sheet_month + interval '1 month')::date)) as usual_days_into_next_month,
       max(h.received_date - (h.sheet_month + interval '1 month')::date) as latest_days_into_next_month
  from public.client_sheet_history h
 where h.received_date is not null and h.client_id is not null
 group by h.company_id, h.client_id;
comment on view public.client_sheet_pay_timing is
  '0631: per Bastion client, from the dated receipts on the pre-Bastion invoice sheets — how many, and the usual day of the month they paid (median). A suggestion for clients.usual_pay_day; invoker, so finance keys only.';
grant select on public.client_sheet_pay_timing to authenticated;

do $test$
declare v_n int; v_msg text;
begin
  -- An ops login (follow-up only) cannot read the history.
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);
    update public.profiles set user_type = 'office_staff', site_scope = '{}', branch_id = null, permissions = array['receivables.follow_up']
     where id = 'c27a9602-6776-401a-a2c1-d755124b931b';
    insert into public.client_sheet_history (company_id, sheet_client, source_name, sheet_month, invoice, source_file, source_row)
    values ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'test', 'test', '2024-04-01', 1, 'test', 1);
    perform set_config('request.jwt.claims', json_build_object('sub', 'c27a9602-6776-401a-a2c1-d755124b931b', 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into v_n from public.client_sheet_history;
    execute 'reset role';
    if v_n <> 0 then raise exception '0631 REFUSED: an ops login can read % history rows.', v_n; end if;
    raise exception '0631-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0631-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0631 REFUSED: security_gaps() reports a gap.'; end if;
end $test$;
