-- 0662 — online bank payments (iNet) are initiated, then released; nothing is paid until released
--
-- Asked 11 Nov 2026 (Shayan): Taha initiates salary transfers on Askari iNet
-- in groups (3–4 per run); the CEO releases them 6–8 hours later. Bastion was
-- marked paid at initiation, so a payment iNet rejected (six HMC rows on
-- 10 Nov, bank name not matching the IBAN) or the CEO held back still read as
-- paid, and the bank balance moved before the bank did.
--
-- DECIDED 11 Nov 2026 (Shayan):
--   * Initiated is IN TRANSIT, not paid: nothing posts and no balance moves
--     until release (option a).
--   * Banks with online banking — Askari mainly, Soneri too; not Allied or
--     BOAJK, which have no iNet — and set per bank, not hard-coded.
--   * Payroll, and also payables cleared by online transfer; part payments too.
--   * Release by anyone holding the key, never the person who initiated that
--     batch (separation of duties, CLAUDE.md: one key would let one person do
--     both stages).
--   * On an iNet bank there is NO direct bank payment: it must go through
--     release.
--   * The payment carries the RELEASE date (when the money leaves the bank).
--   * Cheques are unchanged.
--   * Bastion produces the iNet bulk upload file from the batch (format studied
--     from Shayan's October files, docs/INET_BULK_FILE_FORMAT.md): Askari→Askari
--     (FT) and Askari→other banks (IBFT1) are separate files, so one initiation
--     makes one batch per file. A single instruction is keyed into iNet by hand.
--
-- The change:
--   1. bank_accounts.online_banking / inet_format. Askari: on, 'askari'. Soneri:
--      on, 'soneri' (Soneri Trans@ct templates "Fund Transfer With Purpose" and
--      "Inter Bank Fund Transfer with Purpose", from the samples, bank code list
--      and 1LINK purpose list Shayan shared 12 Nov 2026). A bank switched on
--      with no format makes 'manual' batches — no file, keyed by hand.
--   2. inet_bank_codes — per format, the IBAN bank id → the bank name and code
--      iNet accepted. iNet rejected exactly the rows whose NAME disagreed with
--      the IBAN (11 Nov), so the name is taken from the IBAN and an unknown
--      bank id is refused by name rather than guessed.
--   3. inet_batches / inet_items — the batch (bank, label, reference for the
--      file's ReferenceFeild1 e.g. HMC, file kind, who
--      initiated, who released, iNet's total, rounding) and its items (payslip
--      or vendor payment, amount, and the payee's bank details AS PUT IN THE
--      FILE, so the file can be produced again identically).
--   4. inet_payee(employee, bank) — the file row for one employee, or the
--      reason there cannot be one (no IBAN, unknown bank, bad Askari account).
--   5. initiate_inet_payslips(bank, label, reference, date, items) and
--      initiate_inet_vendor_payment(bank, vendor, amount, expense, label) —
--      bank.inet_initiate. Refuse a held, paid, over-paid or already-initiated
--      payslip, and every payee without usable bank details, by name.
--   6. release_inet_batch(batch, iNet total, rejected items, note) —
--      bank.inet_release, not the initiator. Rejected items return to unpaid.
--      The rest are paid through the SAME functions the buttons use
--      (disburse_payslip, pay_vendor_payables), dated now. A difference
--      between iNet's total and the items of Rs 100 or less moves the bank by
--      that much and posts to 6950 Rounding Differences (0655); more is refused
--      until the rejected items are ticked.
--   7. reject_inet_batch(batch, note) — the whole batch back to unpaid.
--   8. assert_inet_path(bank) by surgery into disburse_payslip,
--      pay_vendor_payables and settle_payable_expense: a bank payment on an
--      iNet bank is refused unless it comes from release.
--      trg_payslip_inet_in_transit refuses raising amount_paid on a payslip
--      with an item in transit by ANY route (cash included) — the double
--      payment.
--   9. bank.inet_initiate and bank.inet_release in permission_keys (and the
--      grant screen, same commit).
--
-- DEFERRED (asked 11 Nov, not yet answered): record_expense with payment mode
-- Bank on an iNet bank is NOT blocked. Bank charges and auto-debits are
-- expenses the bank takes itself, not transfers anyone initiates, and blocking
-- them would make them unrecordable. If the answer is "block it": add the same
-- assert_inet_path call to record_expense for p_payment_mode = 'Bank', and
-- give bank-deducted charges their own mode. Advances and loans paid by bank
-- are not covered either, same reason to ask.
--
-- How release pays without the releaser holding payroll.edit: the payment
-- functions skip their permission gate for a trusted call (auth.uid() null),
-- the house pattern. release_inet_batch has already checked bank.inet_release
-- and the initiator rule, then clears the caller's claims for the loop and
-- restores them after; the payments are recorded against the batch, whose
-- released_by says who released them.
--
-- Asserted on what can break, inside a block rolled back by a sentinel, on an
-- unpaid October payslip with usable bank details: initiating moves no bank
-- and pays nothing; paying it directly on Askari, and paying it in cash while
-- in transit, are both refused with their own messages; its initiator cannot
-- release it; releasing with iNet's total Rs 3 above moves the bank by exactly
-- the item plus 3, posts 3 to Rounding Differences, and leaves the payslip paid.

alter table public.bank_accounts add column if not exists online_banking boolean not null default false;
alter table public.bank_accounts add column if not exists inet_format text;
do $mig$ begin
  if not exists (select 1 from pg_constraint where conname = 'bank_accounts_inet_format_known') then
    alter table public.bank_accounts add constraint bank_accounts_inet_format_known
      check (inet_format is null or inet_format in ('askari', 'soneri'));
  end if;
end $mig$;
comment on column public.bank_accounts.online_banking is
  '0662: payments from this bank go out by online banking (iNet): initiated, then released; no direct bank payment. '
  'DECIDED 11 Nov 2026 (Shayan): Askari and Soneri yes; Allied and BOAJK have no iNet.';
comment on column public.bank_accounts.inet_format is
  '0662: which bulk upload file this bank''s iNet takes (docs/INET_BULK_FILE_FORMAT.md). Null = no file yet: batches are keyed by hand. '
  'askari = Askari iNet (FT / IBFT1, 13 columns); soneri = Soneri Trans@ct "Fund Transfer With Purpose" / "Inter Bank Fund '
  'Transfer with Purpose" (12 Nov 2026, from Soneri''s own samples and bank code list).';

update public.bank_accounts set online_banking = true, inet_format = 'askari'
 where id = '1df9eaa6-afdb-48d1-8f8e-8c69ba867787' and bank_name ilike 'askari%';
update public.bank_accounts set online_banking = true, inet_format = 'soneri'
 where id = 'fd247f1d-e85c-4fd3-8eb5-23fd2f1d7439' and bank_name ilike 'soneri%';

create table if not exists public.inet_bank_codes (
  inet_format   text not null,
  iban_bank_id  text not null check (iban_bank_id ~ '^[A-Z]{4}$'),
  bank_name     text not null,
  bank_code     text not null,
  primary key (inet_format, iban_bank_id)
);
comment on table public.inet_bank_codes is
  '0662: per iNet format, the IBAN bank id → the bank name and code written in the bulk file. Names are as iNet accepted '
  'them on 10 Nov 2026; iNet rejects a row whose name disagrees with its IBAN. A bank not listed is refused at initiate.';
alter table public.inet_bank_codes enable row level security;
revoke all on public.inet_bank_codes from anon, authenticated;
grant select on public.inet_bank_codes to authenticated;
drop policy if exists read_all on public.inet_bank_codes;
create policy read_all on public.inet_bank_codes for select using (auth.uid() is not null);
insert into public.inet_bank_codes (inet_format, iban_bank_id, bank_name, bank_code) values
  ('askari', 'HABB', 'Habib Bank Limited', '111'),
  ('askari', 'ABPA', 'Allied Bank Limited', '106'),
  ('askari', 'NBPA', 'National Bank of Pakistan', '113'),
  ('askari', 'MUCB', 'MCB Bank', '107'),
  ('askari', 'MEZN', 'Meezan Bank Limited', '116'),
  ('askari', 'UNIL', 'United Bank Limited', '116'),
  ('askari', 'ALFH', 'Bank Alfalah Limited', '109'),
  ('askari', 'BAHL', 'Bank Al Habib Limited', '106'),
  -- Soneri: its own numeric codes ("Bank Code List", 12 Nov 2026), names as on that list.
  ('soneri', 'SCBL', 'STANDARD CHARTERED BANK', '2'),
  ('soneri', 'DUIB', 'DUBAI ISLAMI BANK', '3'),
  ('soneri', 'SIND', 'SIND BANK', '4'),
  ('soneri', 'CITI', 'CITI BANK', '5'),
  ('soneri', 'UNIL', 'UNITED BANK', '8'),
  ('soneri', 'MUCB', 'MUSLIM COMMERCIAL BANK', '9'),
  ('soneri', 'ABPA', 'ALLIED BANK', '10'),
  ('soneri', 'HABB', 'HABIB BANK LTD', '11'),
  ('soneri', 'FAYS', 'FAYSAL BANK', '12'),
  ('soneri', 'ASCM', 'ASKARI BANK', '13'),
  ('soneri', 'JSBL', 'JS', '14'),
  ('soneri', 'BPUN', 'BANK OF PUNJAB', '18'),
  ('soneri', 'ALFH', 'BANK ALFALAH', '19'),
  ('soneri', 'MPBL', 'HABIB METRO BANK', '20'),
  ('soneri', 'SAUD', 'SILK BANK', '21'),
  ('soneri', 'MEZN', 'MEEZAN BANK', '22'),
  ('soneri', 'BKIP', 'BANK ISLAMI', '24'),
  ('soneri', 'AIIN', 'ALBARAKA', '26'),
  ('soneri', 'BAHL', 'BANK AL HABIB', '28'),
  ('soneri', 'MCIB', 'MCB Islamic Bank', '31'),
  ('soneri', 'KHYB', 'BANK OF KHYBER', '33'),
  ('soneri', 'NBPA', 'National Bank of Pakistan', '38'),
  ('soneri', 'SADA', 'SadaPay', '52'),
  ('soneri', 'NAYA', 'Nayapay', '53')
on conflict (inet_format, iban_bank_id) do nothing;

create table if not exists public.inet_batches (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id),
  bank_account_id      uuid not null references public.bank_accounts(id),
  label                text not null check (btrim(label) <> ''),
  reference            text,
  file_kind            text not null check (file_kind in ('FT', 'IBFT', 'single', 'manual')),
  transaction_date     date not null default current_date,
  status               text not null default 'initiated' check (status in ('initiated', 'released', 'rejected')),
  initiated_by         uuid default auth.uid(),
  initiated_at         timestamptz not null default now(),
  released_by          uuid,
  released_at          timestamptz,
  inet_total           numeric(14,2),
  rounding_difference  numeric(14,2),
  rounding_journal_id  uuid,
  rejected_by          uuid,
  rejected_at          timestamptz,
  note                 text
);
create index if not exists inet_batches_open_idx on public.inet_batches (company_id, bank_account_id) where status = 'initiated';

create table if not exists public.inet_items (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null references public.inet_batches(id),
  company_id    uuid not null references public.companies(id),
  kind          text not null check (kind in ('payslip', 'vendor')),
  payslip_id    uuid references public.payslips(id),
  vendor_id     uuid references public.vendors(id),
  expense_id    uuid references public.expenses(id),
  amount        numeric(14,2) not null check (amount > 0),
  payee_name    text not null,
  account_no    text,
  bank_name     text,
  bank_code     text,
  status        text not null default 'initiated' check (status in ('initiated', 'released', 'rejected')),
  done_at       timestamptz,
  check ((kind = 'payslip') = (payslip_id is not null)),
  check ((kind = 'vendor') = (vendor_id is not null))
);
create unique index if not exists inet_items_one_open_per_payslip on public.inet_items (payslip_id) where status = 'initiated' and payslip_id is not null;
create index if not exists inet_items_batch_idx on public.inet_items (batch_id);

comment on table public.inet_batches is
  '0662: one iNet group (one upload file, or one hand-keyed instruction). Initiated = in transit: nothing posted, no balance '
  'moved. Written only by initiate_inet_payslips / initiate_inet_vendor_payment / release_inet_batch / reject_inet_batch.';
comment on table public.inet_items is
  '0662: one payment inside an iNet batch, with the payee''s bank details as written in the file.';

do $mig$
declare t text;
begin
  foreach t in array array['inet_batches', 'inet_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists company_members on public.%I', t);
    execute format('create policy company_members on public.%I for select using (company_id = (select public.current_company_id()))', t);
    execute format('drop policy if exists ssa_all on public.%I', t);
    execute format('create policy ssa_all on public.%I for select using ((select public.is_ssa_unscoped()))', t);
    execute format('drop policy if exists perm_read on public.%I', t);
    execute format('create policy perm_read on public.%I as restrictive for select using ('
      || '(select public.has_perm(''bank.inet_initiate'')) or (select public.has_perm(''bank.inet_release'')) '
      || 'or (select public.has_perm(''banks.view'')) or (select public.has_perm(''payroll.view'')) '
      || 'or (select public.has_perm(''payroll.edit'')) or (select public.has_perm(''payables.view'')) '
      || 'or (select public.has_perm(''accounting.edit'')))', t);
  end loop;
end $mig$;

insert into public.permission_keys (key, grp, label) values
  ('bank.inet_initiate', 'Banks & Accounting', 'Initiate online bank payments (iNet)'),
  ('bank.inet_release', 'Banks & Accounting', 'Release online bank payments (iNet) — never a batch you initiated')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- 4. One employee's file row, or why there cannot be one.
create or replace function public.inet_payee(p_employee_id uuid, p_bank_account_id uuid)
returns table(file_kind text, payee_name text, account_no text, bank_name text, bank_code text, problem text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare e record; v_fmt text; v_acct text; v_iban text; v_id text; c record;
begin
  -- 0662. Definer: reads the employee's bank details for the caller's company only.
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    if not (public.has_perm('bank.inet_initiate') or public.has_perm('bank.inet_release')) then
      perform public.require_perm('bank.inet_initiate');
    end if;
  end if;
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  select inet_format into v_fmt from public.bank_accounts where id = p_bank_account_id;
  select x.full_name, x.bank_name, x.bank_account, x.iban, x.account_title into e from public.employees x where x.id = p_employee_id;
  if e.full_name is null then
    return query select null::text, null::text, null::text, null::text, null::text, 'employee not found'::text; return;
  end if;
  payee_name := coalesce(nullif(btrim(e.account_title), ''), e.full_name);

  if v_fmt is null then
    -- No file for this bank yet: keyed by hand. Show what Bastion holds.
    return query select 'manual'::text, payee_name, coalesce(nullif(btrim(e.iban), ''), nullif(btrim(e.bank_account), '')),
                        e.bank_name, null::text, null::text;
    return;
  end if;

  v_iban := upper(regexp_replace(coalesce(e.iban, ''), '\s', '', 'g'));
  if v_fmt = 'askari' and (coalesce(e.bank_name, '') ilike '%askari%' or substr(v_iban, 5, 4) = 'ASCM') then
    -- Askari → Askari (FT): the 13-digit account; its first 3 digits are the branch code.
    v_acct := regexp_replace(coalesce(e.bank_account, ''), '\D', '', 'g');
    if v_acct = '' and v_iban ~ '^PK\d{2}ASCM[0-9]{16}$' then v_acct := right(v_iban, 13); end if;
    if length(v_acct) = 14 and left(v_acct, 1) = '0' then v_acct := substr(v_acct, 2); end if;
    if length(v_acct) = 12 then v_acct := '0' || v_acct; end if;
    if length(v_acct) <> 13 then
      return query select 'FT'::text, payee_name, null::text, 'Askari Bank Limited'::text, null::text,
                          format('Askari account "%s" is not 13 digits', coalesce(e.bank_account, ''));
      return;
    end if;
    return query select 'FT'::text, payee_name, v_acct, 'Askari Bank Limited'::text, left(v_acct, 3), null::text;
    return;
  end if;
  if v_fmt = 'soneri' and (coalesce(e.bank_name, '') ilike '%soneri%' or substr(v_iban, 5, 4) = 'SONE') then
    -- Soneri → Soneri (FT): the Soneri account number, digits only.
    v_acct := regexp_replace(coalesce(e.bank_account, ''), '\D', '', 'g');
    if v_acct = '' and v_iban ~ '^PK\d{2}SONE[0-9]{16}$' then v_acct := ltrim(right(v_iban, 16), '0'); end if;
    if length(v_acct) < 10 or length(v_acct) > 16 then
      return query select 'FT'::text, payee_name, null::text, 'Soneri Bank'::text, null::text,
                          format('Soneri account "%s" is not a Soneri account number', coalesce(e.bank_account, ''));
      return;
    end if;
    return query select 'FT'::text, payee_name, v_acct, 'Soneri Bank'::text, null::text, null::text;
    return;
  end if;

  if v_iban !~ '^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$' then
    return query select 'IBFT'::text, payee_name, null::text, e.bank_name, null::text,
                        case when v_iban = '' then 'no IBAN' else format('IBAN "%s" is not valid', e.iban) end;
    return;
  end if;
  v_id := substr(v_iban, 5, 4);
  select * into c from public.inet_bank_codes k where k.inet_format = v_fmt and k.iban_bank_id = v_id;
  if c.bank_name is null then
    return query select 'IBFT'::text, payee_name, v_iban, e.bank_name, null::text,
                        format('bank %s (%s) is not set up for iNet yet', v_id, coalesce(e.bank_name, '?'));
    return;
  end if;
  return query select 'IBFT'::text, payee_name, v_iban, c.bank_name, c.bank_code, null::text;
end $function$;
comment on function public.inet_payee(uuid, uuid) is
  '0662: the iNet file row for one employee from a bank (FT, IBFT or manual), or the problem that prevents one.';
revoke all on function public.inet_payee(uuid, uuid) from public, anon;
grant execute on function public.inet_payee(uuid, uuid) to authenticated;

-- 4b. Which banks are iNet banks, for the screens that pay (no balances).
create or replace function public.inet_banks()
returns table(id uuid, bank_name text, inet_format text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- 0662. Definer so a payer without banks.view can still tell an iNet bank;
  -- names and formats only, never a balance. Gated by api_function_gates.
  select b.id, b.bank_name, b.inet_format
    from public.bank_accounts b
   where b.online_banking and b.company_id = public.current_company_id()
   order by b.bank_name
$function$;
comment on function public.inet_banks() is '0662: the caller''s iNet banks (id, name, file format) — no balances.';
revoke all on function public.inet_banks() from public, anon;
grant execute on function public.inet_banks() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('inet_banks', array['bank.inet_initiate','bank.inet_release','payroll.edit','payroll.view','accounting.edit','banks.view','payables.view','expenses.edit'],
        'Screens that pay need to know which banks go through iNet')
on conflict (function_name) do update set any_of = excluded.any_of, reason = excluded.reason;

-- 8a. The guard the payment functions call.
create or replace function public.assert_inet_path(p_bank_account_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare b record;
begin
  -- 0662. Not a gate a caller can pass: only release_inet_batch sets the flag,
  -- transaction-local, around its own loop.
  if p_bank_account_id is null then return; end if;
  select bank_name, online_banking into b from public.bank_accounts where id = p_bank_account_id;
  if coalesce(b.online_banking, false) and coalesce(current_setting('bastion.inet_release', true), '') <> 'on' then
    raise exception '% pays by iNet: initiate this payment, and it is paid when the batch is released. Nothing has been recorded.', b.bank_name
      using errcode = '23514';
  end if;
end $function$;
comment on function public.assert_inet_path(uuid) is
  '0662: refuses a bank payment on an iNet bank unless it is made by release_inet_batch.';
revoke all on function public.assert_inet_path(uuid) from public, anon, authenticated;

do $mig$
declare
  v_def text; cnt int; f record;
begin
  for f in
    select * from (values
      ('public.disburse_payslip(uuid,numeric,numeric,text,uuid,uuid,uuid,timestamp with time zone,text,uuid)',
       E'  -- 0542: the card channel.',
       E'  -- 0662: on an iNet bank a payment is made only by release_inet_batch.\n'
       || E'  if p_payment_mode = ''Bank'' and coalesce(p_target_paid, 0) > coalesce(p_expected_paid, 0) then\n'
       || E'    perform public.assert_inet_path(p_bank_account_id);\n  end if;\n\n  -- 0542: the card channel.'),
      ('public.pay_vendor_payables(uuid,numeric,text,uuid,uuid,uuid,text)',
       E'  select v.company_id, v.name into v_company, v_vendor from public.vendors v where v.id = p_vendor_id;',
       E'  -- 0662: on an iNet bank a payment is made only by release_inet_batch.\n'
       || E'  if p_paid_via = ''Bank'' then perform public.assert_inet_path(p_paid_bank_account_id); end if;\n\n'
       || E'  select v.company_id, v.name into v_company, v_vendor from public.vendors v where v.id = p_vendor_id;'),
      ('public.settle_payable_expense(uuid,text,uuid,uuid)',
       E'  select id, company_id, amount, payment_mode, payable_status, vendor_id\n    into e from public.expenses where id = p_expense_id;',
       E'  -- 0662: on an iNet bank a payment is made only by release_inet_batch.\n'
       || E'  if p_paid_via = ''Bank'' then perform public.assert_inet_path(p_paid_bank_account_id); end if;\n\n'
       || E'  select id, company_id, amount, payment_mode, payable_status, vendor_id\n    into e from public.expenses where id = p_expense_id;')
    ) as t(fn, anchor, repl)
  loop
    v_def := pg_get_functiondef(f.fn::regprocedure);
    if position('assert_inet_path' in v_def) > 0 then
      raise notice '0662: % already guarded.', f.fn;
      continue;
    end if;
    cnt := (length(v_def) - length(replace(v_def, f.anchor, ''))) / length(f.anchor);
    if cnt <> 1 then raise exception '0662 REFUSED: % anchor appears % times, expected 1.', f.fn, cnt; end if;
    execute replace(v_def, f.anchor, f.repl);
  end loop;
end $mig$;

-- 8b. No other route may pay a payslip while it is in transit.
create or replace function public.enforce_payslip_inet_in_transit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
  -- 0662. A definer trigger: it fires inside a write the caller already passed
  -- RLS to make. Refuses paying a payslip that has an iNet item in transit,
  -- except from release_inet_batch itself.
declare v_label text;
begin
  if not (coalesce(new.amount_paid, 0) > coalesce(old.amount_paid, 0)
          or (coalesce(new.disbursed, false) and not coalesce(old.disbursed, false))) then
    return new;
  end if;
  if coalesce(current_setting('bastion.inet_release', true), '') = 'on' then return new; end if;
  select b.label into v_label from public.inet_items i join public.inet_batches b on b.id = i.batch_id
   where i.payslip_id = new.id and i.status = 'initiated' limit 1;
  if v_label is null then return new; end if;
  raise exception 'This payslip is in transit on iNet (batch "%"). It is paid when that batch is released; reject it there to pay it another way. Nothing has been recorded.', v_label
    using errcode = '23514';
end $function$;
revoke all on function public.enforce_payslip_inet_in_transit() from public, anon, authenticated;
drop trigger if exists trg_payslip_inet_in_transit on public.payslips;
create trigger trg_payslip_inet_in_transit
  before update of amount_paid, disbursed on public.payslips
  for each row execute function public.enforce_payslip_inet_in_transit();

-- 5a. Initiate payslips.
create or replace function public.initiate_inet_payslips(p_bank_account_id uuid, p_label text, p_reference text, p_transaction_date date, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  b public.bank_accounts; it jsonb; v_ps record; v_amt numeric; v_open numeric; v_payee record;
  v_problems text[] := '{}'; v_batches jsonb := '{}'::jsonb; v_batch uuid; v_kind text; v_n int := 0;
  v_seen uuid[] := '{}';
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('bank.inet_initiate'); end if;
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  select * into b from public.bank_accounts where id = p_bank_account_id;
  if b.id is null then raise exception 'That bank account does not exist. Nothing has been recorded.'; end if;
  if not b.online_banking then raise exception '% has no online banking here; pay it the usual way. Nothing has been recorded.', b.bank_name; end if;
  if nullif(btrim(p_label), '') is null then raise exception 'Give the iNet group a name (e.g. "PCI Oct salaries 1"). Nothing has been recorded.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one payslip. Nothing has been recorded.';
  end if;

  -- First pass: check everything, collect every problem, refuse once with all names.
  for it in select * from jsonb_array_elements(p_items) loop
    select p.id, p.company_id, p.employee_id, p.period_month, p.net_salary, p.amount_paid, p.disbursed,
           e.full_name, e.branch_id
      into v_ps
      from public.payslips p join public.employees e on e.id = p.employee_id
     where p.id = (it->>'payslip_id')::uuid;
    if v_ps.id is null then raise exception 'A payslip in the list does not exist. Nothing has been recorded.'; end if;
    perform public.assert_same_company(v_ps.company_id);
    perform public.assert_branch_writable(v_ps.branch_id);
    if v_ps.id = any(v_seen) then v_problems := v_problems || format('%s: listed twice', v_ps.full_name); continue; end if;
    v_seen := v_seen || v_ps.id;
    v_amt := round(coalesce((it->>'amount')::numeric, 0), 0);
    v_open := round(coalesce(v_ps.net_salary, 0) - coalesce(v_ps.amount_paid, 0), 0);
    if exists (select 1 from public.inet_items i where i.payslip_id = v_ps.id and i.status = 'initiated') then
      v_problems := v_problems || format('%s: already in transit', v_ps.full_name);
    elsif exists (select 1 from public.payroll_holds h where h.employee_id = v_ps.employee_id
                    and h.period_month = date_trunc('month', v_ps.period_month)::date and h.released_at is null) then
      v_problems := v_problems || format('%s: payslip on hold', v_ps.full_name);
    elsif v_ps.disbursed or v_open <= 0 then
      v_problems := v_problems || format('%s: nothing left to pay', v_ps.full_name);
    elsif v_amt <= 0 or v_amt > v_open then
      v_problems := v_problems || format('%s: %s is not between 1 and the %s still owed', v_ps.full_name,
                                         to_char(v_amt, 'FM999,999,990'), to_char(v_open, 'FM999,999,990'));
    else
      select * into v_payee from public.inet_payee(v_ps.employee_id, b.id);
      if v_payee.problem is not null then v_problems := v_problems || format('%s: %s', v_ps.full_name, v_payee.problem); end if;
    end if;
  end loop;
  if cardinality(v_problems) > 0 then
    raise exception 'Not initiated — fix these first: %. Nothing has been recorded.', array_to_string(v_problems, '; ')
      using errcode = '23514';
  end if;

  -- Second pass: one batch per file kind.
  for it in select * from jsonb_array_elements(p_items) loop
    select p.id, p.company_id, p.employee_id into v_ps from public.payslips p where p.id = (it->>'payslip_id')::uuid;
    select * into v_payee from public.inet_payee(v_ps.employee_id, b.id);
    v_kind := v_payee.file_kind;
    v_batch := (v_batches->>v_kind)::uuid;
    if v_batch is null then
      insert into public.inet_batches (company_id, bank_account_id, label, reference, file_kind, transaction_date)
      values (b.company_id, b.id,
              btrim(p_label) || case v_kind when 'FT' then ' (' || split_part(b.bank_name, ' ', 1) || ' accounts)' when 'IBFT' then ' (other banks)' else '' end,
              nullif(upper(btrim(p_reference)), ''), v_kind, coalesce(p_transaction_date, current_date))
      returning id into v_batch;
      v_batches := v_batches || jsonb_build_object(v_kind, v_batch);
    end if;
    insert into public.inet_items (batch_id, company_id, kind, payslip_id, amount, payee_name, account_no, bank_name, bank_code)
    values (v_batch, b.company_id, 'payslip', v_ps.id, round((it->>'amount')::numeric, 0),
            v_payee.payee_name, v_payee.account_no, v_payee.bank_name, v_payee.bank_code);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('items', v_n, 'batches', v_batches);
end $function$;
comment on function public.initiate_inet_payslips(uuid, text, text, date, jsonb) is
  '0662: put payslips in transit on iNet — one batch per upload file (Askari / other banks). Nothing posts or moves.';
revoke all on function public.initiate_inet_payslips(uuid, text, text, date, jsonb) from public, anon;
grant execute on function public.initiate_inet_payslips(uuid, text, text, date, jsonb) to authenticated;

-- 5b. Initiate a vendor payment (a single instruction, keyed by hand).
create or replace function public.initiate_inet_vendor_payment(p_bank_account_id uuid, p_vendor_id uuid, p_amount numeric,
                                                              p_expense_id uuid, p_label text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare b public.bank_accounts; v record; v_batch uuid; v_branch uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('bank.inet_initiate'); end if;
  if p_bank_account_id is not null then
    perform public.assert_same_company((select company_id from public.bank_accounts where id = p_bank_account_id));
  end if;
  if p_vendor_id is not null then
    perform public.assert_same_company((select company_id from public.vendors where id = p_vendor_id));
  end if;
  if p_expense_id is not null then
    perform public.assert_same_company((select company_id from public.expenses where id = p_expense_id));
    select branch_id into v_branch from public.expenses where id = p_expense_id;
  end if;
  perform public.assert_branch_writable(v_branch);
  select * into b from public.bank_accounts where id = p_bank_account_id;
  if b.id is null or not b.online_banking then raise exception 'Choose an iNet bank. Nothing has been recorded.'; end if;
  select x.name, x.account_title, x.account_number, x.bank_name into v from public.vendors x where x.id = p_vendor_id;
  if v.name is null then raise exception 'That vendor does not exist. Nothing has been recorded.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter an amount greater than zero. Nothing has been recorded.'; end if;
  insert into public.inet_batches (company_id, bank_account_id, label, file_kind)
  values (b.company_id, b.id, coalesce(nullif(btrim(p_label), ''), 'Vendor: ' || v.name), 'single')
  returning id into v_batch;
  insert into public.inet_items (batch_id, company_id, kind, vendor_id, expense_id, amount, payee_name, account_no, bank_name)
  values (v_batch, b.company_id, 'vendor', p_vendor_id, p_expense_id, round(p_amount, 2),
          coalesce(nullif(btrim(v.account_title), ''), v.name), v.account_number, v.bank_name);
  return v_batch;
end $function$;
comment on function public.initiate_inet_vendor_payment(uuid, uuid, numeric, uuid, text) is
  '0662: put a vendor payment in transit on iNet (single instruction keyed by hand). Paid by pay_vendor_payables on release.';
revoke all on function public.initiate_inet_vendor_payment(uuid, uuid, numeric, uuid, text) from public, anon;
grant execute on function public.initiate_inet_vendor_payment(uuid, uuid, numeric, uuid, text) to authenticated;

-- 6. Release.
create or replace function public.release_inet_batch(p_batch_id uuid, p_inet_total numeric, p_rejected_item_ids uuid[], p_note text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  bt public.inet_batches; it public.inet_items; v_uid uuid := auth.uid(); v_claims text; v_sub text;
  v_sum numeric := 0; v_diff numeric; v_paid numeric; v_left int; v_bad int; v_je uuid; v_desc text;
  v_ps record; v_n int := 0;
begin
  if v_uid is not null and pg_trigger_depth() = 0 then perform public.require_perm('bank.inet_release'); end if;
  if p_batch_id is not null then
    perform public.assert_same_company((select company_id from public.inet_batches where id = p_batch_id));
  end if;
  select * into bt from public.inet_batches where id = p_batch_id for update;
  if bt.id is null then raise exception 'That batch does not exist. Nothing has been recorded.'; end if;
  if bt.status <> 'initiated' then raise exception 'Batch "%" is already %. Nothing has been recorded.', bt.label, bt.status; end if;
  if v_uid is not null and bt.initiated_by = v_uid then
    raise exception 'You initiated batch "%", so someone else must release it. Nothing has been recorded.', bt.label
      using errcode = '42501';
  end if;
  -- every rejected id must be an item of THIS batch (p_rejected_item_ids)
  select count(*) into v_bad from unnest(coalesce(p_rejected_item_ids, '{}'::uuid[])) x
   where not exists (select 1 from public.inet_items i where i.id = x and i.batch_id = bt.id and i.status = 'initiated');
  if v_bad > 0 then raise exception 'A rejected item is not in this batch. Nothing has been recorded.'; end if;

  update public.inet_items set status = 'rejected', done_at = now()
   where batch_id = bt.id and status = 'initiated' and id = any(coalesce(p_rejected_item_ids, '{}'::uuid[]));
  select coalesce(sum(amount), 0), count(*) into v_sum, v_left from public.inet_items where batch_id = bt.id and status = 'initiated';

  if v_left = 0 then
    update public.inet_batches set status = 'rejected', rejected_by = v_uid, rejected_at = now(), note = nullif(btrim(p_note), '')
     where id = bt.id;
    return jsonb_build_object('released', 0, 'rejected', cardinality(coalesce(p_rejected_item_ids, '{}'::uuid[])));
  end if;

  if p_inet_total is null or p_inet_total <= 0 then
    raise exception 'Enter the total iNet sent for "%". Nothing has been recorded.', bt.label;
  end if;
  v_diff := round(p_inet_total - v_sum, 2);
  if abs(v_diff) > 100 then
    raise exception 'iNet sent % but the items left in "%" come to % — a difference of %. Tick the items iNet rejected, or check the total. Nothing has been recorded.',
      to_char(p_inet_total, 'FM999,999,990.00'), bt.label, to_char(v_sum, 'FM999,999,990.00'), to_char(v_diff, 'FM999,999,990.00')
      using errcode = '23514';
  end if;

  -- Pay each item through the same function its button uses. The caller's
  -- claims are cleared for the loop (the payment functions skip their gate for
  -- a trusted call) and restored after; the release flag lets the iNet guard
  -- through. Both settings are transaction-local.
  v_claims := current_setting('request.jwt.claims', true);
  v_sub := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('bastion.inet_release', 'on', true);

  for it in select * from public.inet_items where batch_id = bt.id and status = 'initiated' order by id loop
    if it.kind = 'payslip' then
      select p.id, p.amount_paid, p.period_month, e.full_name, coalesce(e.employee_code, e.guard_code) as code
        into v_ps from public.payslips p join public.employees e on e.id = p.employee_id
       where p.id = it.payslip_id for update of p;
      v_paid := round(coalesce(v_ps.amount_paid, 0), 0);
      perform public.disburse_payslip(it.payslip_id, v_paid, v_paid + it.amount, 'Bank', bt.bank_account_id, null, null, now(),
        format('Payroll %s · %s %s (iNet: %s)', to_char(v_ps.period_month, 'FMMonth YYYY'), v_ps.code, v_ps.full_name, bt.label), null);
    else
      perform public.pay_vendor_payables(it.vendor_id, it.amount, 'Bank', bt.bank_account_id, null, it.expense_id,
        format('iNet: %s', bt.label));
    end if;
    update public.inet_items set status = 'released', done_at = now() where id = it.id;
    v_n := v_n + 1;
  end loop;

  if v_diff <> 0 then
    -- v_diff > 0: the bank sent more than the items (rounding) — the bank goes
    -- down by it and Rounding Differences takes a debit. < 0: mirror.
    v_desc := format('iNet rounding: %s (sent %s, items %s)', bt.label,
                     to_char(p_inet_total, 'FM999,999,990.00'), to_char(v_sum, 'FM999,999,990.00'));
    perform public.apply_money_delta(bt.company_id, 'Bank', bt.bank_account_id, -v_diff, 'adjustment', v_desc, bt.id::text);
    v_je := public.post_journal(bt.company_id, current_date, v_desc, 'inet_batches', bt.id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', public.ensure_rounding_account(bt.company_id),
                           'debit', greatest(v_diff, 0), 'credit', greatest(-v_diff, 0)),
        jsonb_build_object('account_id', public.bank_account_gl(bt.company_id, bt.bank_account_id),
                           'debit', greatest(-v_diff, 0), 'credit', greatest(v_diff, 0))),
      null, false);
  end if;

  perform set_config('bastion.inet_release', '', true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);

  update public.inet_batches
     set status = 'released', released_by = v_uid, released_at = now(), inet_total = round(p_inet_total, 2),
         rounding_difference = v_diff, rounding_journal_id = v_je, note = nullif(btrim(p_note), '')
   where id = bt.id;
  return jsonb_build_object('released', v_n, 'rejected', cardinality(coalesce(p_rejected_item_ids, '{}'::uuid[])),
                            'rounding', v_diff);
end $function$;
comment on function public.release_inet_batch(uuid, numeric, uuid[], text) is
  '0662: release an iNet batch — rejected items back to unpaid, the rest paid (dated now) through disburse_payslip / '
  'pay_vendor_payables; a difference up to Rs 100 to Rounding Differences. Not by the batch''s initiator.';
revoke all on function public.release_inet_batch(uuid, numeric, uuid[], text) from public, anon;
grant execute on function public.release_inet_batch(uuid, numeric, uuid[], text) to authenticated;

-- 7. Reject a whole batch.
create or replace function public.reject_inet_batch(p_batch_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare bt public.inet_batches; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    if not (public.has_perm('bank.inet_initiate') or public.has_perm('bank.inet_release')) then
      perform public.require_perm('bank.inet_release');
    end if;
  end if;
  if p_batch_id is not null then
    perform public.assert_same_company((select company_id from public.inet_batches where id = p_batch_id));
  end if;
  select * into bt from public.inet_batches where id = p_batch_id for update;
  if bt.id is null then raise exception 'That batch does not exist. Nothing has been recorded.'; end if;
  if bt.status <> 'initiated' then raise exception 'Batch "%" is already %. Nothing has been recorded.', bt.label, bt.status; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Say why the batch is rejected. Nothing has been recorded.'; end if;
  update public.inet_items set status = 'rejected', done_at = now() where batch_id = bt.id and status = 'initiated';
  update public.inet_batches set status = 'rejected', rejected_by = auth.uid(), rejected_at = now(), note = btrim(p_note)
   where id = bt.id and status = 'initiated';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The batch could not be rejected. Nothing has been recorded.'; end if;
end $function$;
comment on function public.reject_inet_batch(uuid, text) is
  '0662: reject a whole iNet batch — every item back to unpaid (note required).';
revoke all on function public.reject_inet_batch(uuid, text) from public, anon;
grant execute on function public.reject_inet_batch(uuid, text) to authenticated;

-- Asserted on what can break.
do $mig$
declare
  v_ps record; v_bank uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787'; v_bal0 numeric; v_bal1 numeric; v_bal2 numeric;
  v_res jsonb; v_batch uuid; v_item uuid; v_msg text; v_ok boolean := false; v_user uuid; v_round numeric;
begin
  select p.id, p.employee_id, p.net_salary, p.amount_paid, p.company_id into v_ps
    from public.payslips p join public.employees e on e.id = p.employee_id
   where p.period_month = '2026-10-01' and not p.disbursed and p.net_salary - p.amount_paid >= 1
     and not exists (select 1 from public.payroll_holds h where h.employee_id = p.employee_id and h.released_at is null)
     and not exists (select 1 from public.inet_items i where i.payslip_id = p.id and i.status = 'initiated')
     and (select x.problem from public.inet_payee(p.employee_id, '1df9eaa6-afdb-48d1-8f8e-8c69ba867787') x) is null
   order by p.id limit 1;
  if v_ps.id is null then
    raise notice '0662: no unpaid October payslip with usable bank details; the payment test is skipped.';
  else
    select p.id into v_user from public.profiles p
     where coalesce(p.view_as_company, p.company_id) = v_ps.company_id and p.role = 'super_admin' order by p.id limit 1;
    begin
      select balance into v_bal0 from public.bank_accounts where id = v_bank;
      perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

      v_res := public.initiate_inet_payslips(v_bank, '0662 test', 'TEST', current_date,
                 jsonb_build_array(jsonb_build_object('payslip_id', v_ps.id, 'amount', round(v_ps.net_salary - v_ps.amount_paid))));
      select balance into v_bal1 from public.bank_accounts where id = v_bank;
      if v_bal1 <> v_bal0 then raise exception '0662 REFUSED: initiating moved Askari (% -> %).', v_bal0, v_bal1; end if;
      if (select amount_paid from public.payslips where id = v_ps.id) <> v_ps.amount_paid then
        raise exception '0662 REFUSED: initiating paid the payslip.';
      end if;
      select i.id, i.batch_id into v_item, v_batch from public.inet_items i where i.payslip_id = v_ps.id and i.status = 'initiated';

      -- direct payment on Askari: refused
      begin
        perform set_config('request.jwt.claims', '{}', true);
        perform public.disburse_payslip(v_ps.id, v_ps.amount_paid, v_ps.net_salary, 'Bank', v_bank, null, null, now(), '0662 test', null);
        v_msg := '0662_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'Askari Bank pays by iNet: initiate this payment%' then
        raise exception '0662 REFUSED: a direct Askari payment was not refused by the iNet guard; got: %', v_msg;
      end if;
      -- cash while in transit: refused
      begin
        update public.payslips set amount_paid = net_salary where id = v_ps.id;
        v_msg := '0662_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'This payslip is in transit on iNet (batch "0662 test%' then
        raise exception '0662 REFUSED: paying a payslip in transit was not refused; got: %', v_msg;
      end if;

      -- the initiator cannot release
      perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
      begin
        perform public.release_inet_batch(v_batch, 1, null, null);
        v_msg := '0662_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'You initiated batch "0662 test%so someone else must release it.%' then
        raise exception '0662 REFUSED: the initiator was not refused at release; got: %', v_msg;
      end if;

      -- release by someone else (a trusted call here), iNet total 3 above
      perform set_config('request.jwt.claims', '{}', true);
      v_res := public.release_inet_batch(v_batch, round(v_ps.net_salary - v_ps.amount_paid) + 3, null, '0662 test');
      select balance into v_bal2 from public.bank_accounts where id = v_bank;
      if v_bal0 - v_bal2 <> round(v_ps.net_salary - v_ps.amount_paid) + 3 then
        raise exception '0662 REFUSED: release moved Askari by %, expected %.', v_bal0 - v_bal2, round(v_ps.net_salary - v_ps.amount_paid) + 3;
      end if;
      if not (select disbursed from public.payslips where id = v_ps.id) then
        raise exception '0662 REFUSED: after release the payslip is not paid.';
      end if;
      select coalesce(sum(l.debit) - sum(l.credit), 0) into v_round
        from public.journal_lines l join public.journal_entries j on j.id = l.journal_entry_id
       where j.source_table = 'inet_batches' and j.source_id = v_batch
         and l.account_id = public.ensure_rounding_account(v_ps.company_id);
      if v_round <> 3 then raise exception '0662 REFUSED: Rounding Differences took %, expected a debit of 3.', v_round; end if;
      v_ok := true;
      raise exception '0662_SENTINEL';
    exception when others then
      if sqlerrm <> '0662_SENTINEL' then raise; end if;
    end;
    if not v_ok then raise exception '0662 REFUSED: the rolled-back test did not complete.'; end if;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0662 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0662 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('initiate_inet_payslips', 'initiate_inet_vendor_payment', 'release_inet_batch',
                                      'reject_inet_batch', 'inet_payee', 'assert_inet_path')) then
    raise exception '0662 REFUSED: branch_guard_gaps() reports one of 0662''s functions.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0662 REFUSED: permission_key_gaps() reports a gap.'; end if;

  -- Soneri: an HBL payee is an IBFT row with Soneri's own code 11 and its spelling.
  declare v_e uuid; v_p record;
  begin
    select e.id into v_e from public.employees e
     where e.status = 'Active' and upper(replace(e.iban, ' ', '')) ~ '^PK\d{2}HABB[0-9A-Z]{16}$' order by e.id limit 1;
    if v_e is not null then
      select * into v_p from public.inet_payee(v_e, 'fd247f1d-e85c-4fd3-8eb5-23fd2f1d7439');
      if (v_p.file_kind, v_p.bank_code, v_p.bank_name) is distinct from ('IBFT', '11', 'HABIB BANK LTD') or v_p.problem is not null then
        raise exception '0662 REFUSED: a Soneri HBL row came out as % / % / % (problem %).', v_p.file_kind, v_p.bank_code, v_p.bank_name, v_p.problem;
      end if;
    end if;
  end;
end $mig$;