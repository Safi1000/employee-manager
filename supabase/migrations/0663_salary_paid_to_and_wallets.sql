-- 0663 — a guard's salary paid to someone else, and mobile wallets in the iNet file
--
-- Asked 12 Nov 2026 (Shayan), after initiating PCI's October salaries on
-- Askari: a guard's pay is sometimes sent to another guard or person, because
-- he has no online banking or asked for it. And most PCI payees are mobile
-- wallets, which 0662 refused outright (no IBAN).
--
-- DECIDED 12 Nov 2026 (Shayan):
--   * "Paid to someone else" is allowed, to ANYONE (not only employees).
--   * NO GROUPING. Three guards paid to one receiver are three rows of their
--     own amounts, never one combined transfer: each payslip keeps its own
--     instruction and its own record; the receiving account just repeats.
--   * Wallet accounts are accepted in Askari's bulk file.
--
-- The change:
--   1. salary_payees — a standing "salary paid to" on a guard: receiver's name,
--      bank or wallet, account/IBAN, reason, who set it and when. One open per
--      guard. Set and ended only through set_salary_payee / end_salary_payee
--      (payroll.edit, reason required, logged by the row itself). Redirecting
--      a salary is the classic payroll fraud, so every such row is visible on
--      the release screen before anyone releases it.
--   2. inet_wallet_codes — per iNet format, the wallet (as employees.bank_name
--      names it, e.g. 'Easypaisa (Wallet)') → the bank name and code for the
--      file. Soneri from its own Bank Code List (Telenor Microfinance 25,
--      MobiLink Micro Finance 32, Nayapay 53, SadaPay 52). Askari: DEFERRED —
--      the spelling iNet accepts for a wallet row is not yet known (Shayan to
--      confirm or share an old file); until a row is added here an Askari
--      wallet payee is refused BY NAME at initiate, not guessed. When known:
--        insert into inet_wallet_codes values ('askari','Easypaisa (Wallet)','<name>','<code>'), …
--   3. inet_payee restated (one author, 0662; its body is asserted to be the
--      digest 0662 left before it is replaced): reads an open salary_payees
--      row first, and handles wallets (11-digit mobile number 03XXXXXXXXX).
--      Returns account_kind, on_behalf_of and salary_payee_id as well.
--   4. inet_items.account_kind / on_behalf_of / salary_payee_id, written by
--      initiate_inet_payslips (surgery, one anchor).
--   5. release_inet_batch (surgery, one anchor): the payment's description says
--      "— paid to <receiver>" when the item was paid to someone else.
--
-- Not covered: paying someone else in cash or by cheque (this is the bank /
-- iNet path only), and a one-off receiver for a single month without setting
-- a standing one (set it, initiate, end it).

-- 1. Standing "salary paid to".
create table if not exists public.salary_payees (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id),
  employee_id  uuid not null references public.employees(id),
  payee_name   text not null check (btrim(payee_name) <> ''),
  bank_name    text not null check (btrim(bank_name) <> ''),
  account_no   text,
  iban         text,
  reason       text not null check (length(btrim(reason)) >= 5),
  set_by       uuid default auth.uid(),
  set_at       timestamptz not null default now(),
  ended_at     timestamptz,
  ended_by     uuid,
  end_note     text,
  check (nullif(btrim(account_no), '') is not null or nullif(btrim(iban), '') is not null)
);
create unique index if not exists salary_payees_one_open on public.salary_payees (employee_id) where ended_at is null;
comment on table public.salary_payees is
  '0663: a guard''s salary paid to someone else (any person), standing until ended. DECIDED 12 Nov 2026 (Shayan): allowed to '
  'anyone; never grouped — each payslip stays its own transfer. Written only by set_salary_payee / end_salary_payee.';
alter table public.salary_payees enable row level security;
revoke all on public.salary_payees from anon, authenticated;
grant select on public.salary_payees to authenticated;
drop policy if exists company_members on public.salary_payees;
create policy company_members on public.salary_payees for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.salary_payees;
create policy ssa_all on public.salary_payees for select using ((select public.is_ssa_unscoped()));
drop policy if exists perm_read on public.salary_payees;
create policy perm_read on public.salary_payees as restrictive for select using (
  (select public.has_perm('payroll.view')) or (select public.has_perm('payroll.edit'))
  or (select public.has_perm('employees.view')) or (select public.has_perm('employees.edit'))
  or (select public.has_perm('bank.inet_initiate')) or (select public.has_perm('bank.inet_release')));

create or replace function public.set_salary_payee(p_employee_id uuid, p_payee_name text, p_bank_name text,
                                                   p_account_no text, p_iban text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare e record; v_id uuid; v_acct text; v_iban text;
begin
  -- 0663. payroll.edit: it decides where a salary goes.
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;
  select id, company_id, branch_id, full_name into e from public.employees where id = p_employee_id;
  if e.id is null then raise exception 'That employee does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(e.branch_id);
  if nullif(btrim(p_payee_name), '') is null then raise exception 'Name the person the salary is paid to. Nothing has been recorded.'; end if;
  if nullif(btrim(p_bank_name), '') is null then raise exception 'Choose the receiver''s bank or wallet. Nothing has been recorded.'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Say why %''s salary goes to someone else. Nothing has been recorded.', e.full_name; end if;
  v_acct := nullif(btrim(p_account_no), '');
  v_iban := nullif(upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')), '');
  if v_acct is null and v_iban is null then raise exception 'Enter the receiver''s account number, mobile number or IBAN. Nothing has been recorded.'; end if;
  if v_iban is not null and v_iban !~ '^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$' then
    raise exception 'IBAN "%" is not a Pakistani IBAN (PK + 22 characters). Nothing has been recorded.', p_iban;
  end if;

  update public.salary_payees set ended_at = now(), ended_by = auth.uid(), end_note = 'Replaced by a new receiver'
   where employee_id = e.id and ended_at is null;
  insert into public.salary_payees (company_id, employee_id, payee_name, bank_name, account_no, iban, reason)
  values (e.company_id, e.id, btrim(p_payee_name), btrim(p_bank_name), v_acct, v_iban, btrim(p_reason))
  returning id into v_id;
  return v_id;
end $function$;
comment on function public.set_salary_payee(uuid, text, text, text, text, text) is
  '0663: pay this guard''s salary to someone else (standing, until ended). Replaces any open receiver.';
revoke all on function public.set_salary_payee(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.set_salary_payee(uuid, text, text, text, text, text) to authenticated;

create or replace function public.end_salary_payee(p_salary_payee_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record; v_n int;
begin
  -- 0663.
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('payroll.edit'); end if;
  if p_salary_payee_id is not null then
    perform public.assert_same_company((select company_id from public.salary_payees where id = p_salary_payee_id));
  end if;
  select s.id, e.branch_id into r from public.salary_payees s join public.employees e on e.id = s.employee_id
   where s.id = p_salary_payee_id;
  if r.id is null then raise exception 'That receiver does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(r.branch_id);
  update public.salary_payees set ended_at = now(), ended_by = auth.uid(), end_note = nullif(btrim(p_note), '')
   where id = r.id and ended_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'This receiver has already been ended. Nothing has been recorded.'; end if;
end $function$;
comment on function public.end_salary_payee(uuid, text) is '0663: stop paying a guard''s salary to someone else.';
revoke all on function public.end_salary_payee(uuid, text) from public, anon;
grant execute on function public.end_salary_payee(uuid, text) to authenticated;

-- 2. Wallets in the file.
create table if not exists public.inet_wallet_codes (
  inet_format  text not null,
  wallet_name  text not null,
  bank_name    text not null,
  bank_code    text not null,
  primary key (inet_format, wallet_name)
);
comment on table public.inet_wallet_codes is
  '0663: per iNet format, the wallet (as employees.bank_name names it) → bank name and code in the bulk file. A wallet not '
  'listed for a format is refused at initiate by name. Askari: DEFERRED 12 Nov 2026 — spelling to be confirmed by Shayan.';
alter table public.inet_wallet_codes enable row level security;
revoke all on public.inet_wallet_codes from anon, authenticated;
grant select on public.inet_wallet_codes to authenticated;
drop policy if exists read_all on public.inet_wallet_codes;
create policy read_all on public.inet_wallet_codes for select using (auth.uid() is not null);
insert into public.inet_wallet_codes (inet_format, wallet_name, bank_name, bank_code) values
  ('soneri', 'Easypaisa (Wallet)', 'Telenor Microfinance Bank', '25'),
  ('soneri', 'JazzCash (Wallet)', 'MobiLink Micro Finance Bank', '32'),
  ('soneri', 'JazzCash (Mobilink Microfinance Bank)', 'MobiLink Micro Finance Bank', '32'),
  ('soneri', 'NayaPay (Wallet)', 'Nayapay', '53'),
  ('soneri', 'SadaPay (Wallet)', 'SadaPay', '52')
on conflict (inet_format, wallet_name) do nothing;

-- 4 (columns first, the functions below write them).
alter table public.inet_items add column if not exists account_kind text;
alter table public.inet_items add column if not exists on_behalf_of text;
alter table public.inet_items add column if not exists salary_payee_id uuid references public.salary_payees(id);
do $mig$ begin
  if not exists (select 1 from pg_constraint where conname = 'inet_items_account_kind_known') then
    alter table public.inet_items add constraint inet_items_account_kind_known
      check (account_kind is null or account_kind in ('account', 'iban', 'wallet', 'manual'));
  end if;
end $mig$;
comment on column public.inet_items.on_behalf_of is
  '0663: when the salary was paid to someone else, the guard it belongs to (payee_name is then the receiver).';

-- 3. inet_payee, restated. One author (0662): refuse anything but the body 0662 left.
do $mig$
declare v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p
   where p.oid = 'public.inet_payee(uuid,uuid)'::regprocedure;
  if v_md5 is distinct from '76e6d1afb276132932e3c8a8208f4546'
     and not exists (select 1 from pg_proc p where p.oid = 'public.inet_payee(uuid,uuid)'::regprocedure and p.prosrc like '%0663%') then
    raise exception '0663 REFUSED: inet_payee is not the body 0662 left (md5 %); an unrecorded edit would be lost.', v_md5;
  end if;
end $mig$;
drop function if exists public.inet_payee(uuid, uuid);
create function public.inet_payee(p_employee_id uuid, p_bank_account_id uuid)
returns table(file_kind text, payee_name text, account_no text, bank_name text, bank_code text, problem text,
              account_kind text, on_behalf_of text, salary_payee_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  e record; s record; v_fmt text; v_bankname text; v_acct text; v_iban text; v_id text; c record;
  v_name text; v_bname text; v_raw_acct text; v_raw_iban text; v_behalf text; v_sp uuid; v_who text;
begin
  -- 0662, restated by 0663: an open salary_payees row first; wallets by mobile number.
  -- Definer: reads bank details for the caller's company only.
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
  select b.inet_format, b.bank_name into v_fmt, v_bankname from public.bank_accounts b where b.id = p_bank_account_id;
  select x.full_name, x.bank_name, x.bank_account, x.iban, x.account_title into e from public.employees x where x.id = p_employee_id;
  if e.full_name is null then
    return query select null::text, null::text, null::text, null::text, null::text, 'employee not found'::text,
                        null::text, null::text, null::uuid;
    return;
  end if;

  select sp.id, sp.payee_name, sp.bank_name, sp.account_no, sp.iban into s
    from public.salary_payees sp where sp.employee_id = p_employee_id and sp.ended_at is null;
  if s.id is not null then
    v_name := s.payee_name; v_bname := s.bank_name; v_raw_acct := s.account_no; v_raw_iban := s.iban;
    v_behalf := e.full_name; v_sp := s.id; v_who := format('paid to %s — ', s.payee_name);
  else
    v_name := coalesce(nullif(btrim(e.account_title), ''), e.full_name); v_bname := e.bank_name;
    v_raw_acct := e.bank_account; v_raw_iban := e.iban; v_behalf := null; v_sp := null; v_who := '';
  end if;

  if v_fmt is null then
    -- No file for this bank yet: keyed by hand. Show what Bastion holds.
    return query select 'manual'::text, v_name, coalesce(nullif(btrim(v_raw_iban), ''), nullif(btrim(v_raw_acct), '')),
                        v_bname, null::text, null::text, 'manual'::text, v_behalf, v_sp;
    return;
  end if;

  v_iban := upper(regexp_replace(coalesce(v_raw_iban, ''), '\s', '', 'g'));

  -- Mobile wallets: the account is an 11-digit mobile number; the name and code come from inet_wallet_codes.
  if coalesce(v_bname, '') ~* '\(wallet\)\s*$' or coalesce(v_bname, '') ilike 'jazzcash%' then
    v_acct := regexp_replace(coalesce(v_raw_acct, ''), '\D', '', 'g');
    if length(v_acct) = 12 and left(v_acct, 2) = '92' then v_acct := '0' || substr(v_acct, 3); end if;
    if length(v_acct) = 10 and left(v_acct, 1) = '3' then v_acct := '0' || v_acct; end if;
    if v_acct !~ '^03\d{9}$' then
      return query select 'IBFT'::text, v_name, null::text, v_bname, null::text,
                          v_who || format('%s number "%s" is not an 11-digit mobile number', v_bname, coalesce(v_raw_acct, '')),
                          'wallet'::text, v_behalf, v_sp;
      return;
    end if;
    select * into c from public.inet_wallet_codes w where w.inet_format = v_fmt and w.wallet_name = btrim(v_bname);
    if c.bank_name is null then
      return query select 'IBFT'::text, v_name, v_acct, v_bname, null::text,
                          v_who || format('%s is not set up for %s iNet yet', v_bname, v_bankname),
                          'wallet'::text, v_behalf, v_sp;
      return;
    end if;
    return query select 'IBFT'::text, v_name, v_acct, c.bank_name, c.bank_code, null::text, 'wallet'::text, v_behalf, v_sp;
    return;
  end if;

  if v_fmt = 'askari' and (coalesce(v_bname, '') ilike '%askari%' or substr(v_iban, 5, 4) = 'ASCM') then
    -- Askari → Askari (FT): the 13-digit account; its first 3 digits are the branch code.
    v_acct := regexp_replace(coalesce(v_raw_acct, ''), '\D', '', 'g');
    if v_acct = '' and v_iban ~ '^PK\d{2}ASCM[0-9]{16}$' then v_acct := right(v_iban, 13); end if;
    if length(v_acct) = 14 and left(v_acct, 1) = '0' then v_acct := substr(v_acct, 2); end if;
    if length(v_acct) = 12 then v_acct := '0' || v_acct; end if;
    if length(v_acct) <> 13 then
      return query select 'FT'::text, v_name, null::text, 'Askari Bank Limited'::text, null::text,
                          v_who || format('Askari account "%s" is not 13 digits', coalesce(v_raw_acct, '')),
                          'account'::text, v_behalf, v_sp;
      return;
    end if;
    return query select 'FT'::text, v_name, v_acct, 'Askari Bank Limited'::text, left(v_acct, 3), null::text,
                        'account'::text, v_behalf, v_sp;
    return;
  end if;
  if v_fmt = 'soneri' and (coalesce(v_bname, '') ilike '%soneri%' or substr(v_iban, 5, 4) = 'SONE') then
    -- Soneri → Soneri (FT): the Soneri account number, digits only.
    v_acct := regexp_replace(coalesce(v_raw_acct, ''), '\D', '', 'g');
    if v_acct = '' and v_iban ~ '^PK\d{2}SONE[0-9]{16}$' then v_acct := ltrim(right(v_iban, 16), '0'); end if;
    if length(v_acct) < 10 or length(v_acct) > 16 then
      return query select 'FT'::text, v_name, null::text, 'Soneri Bank'::text, null::text,
                          v_who || format('Soneri account "%s" is not a Soneri account number', coalesce(v_raw_acct, '')),
                          'account'::text, v_behalf, v_sp;
      return;
    end if;
    return query select 'FT'::text, v_name, v_acct, 'Soneri Bank'::text, null::text, null::text, 'account'::text, v_behalf, v_sp;
    return;
  end if;

  if v_iban !~ '^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$' then
    return query select 'IBFT'::text, v_name, null::text, v_bname, null::text,
                        v_who || case when v_iban = '' then 'no IBAN' else format('IBAN "%s" is not valid', v_raw_iban) end,
                        'iban'::text, v_behalf, v_sp;
    return;
  end if;
  v_id := substr(v_iban, 5, 4);
  select * into c from public.inet_bank_codes k where k.inet_format = v_fmt and k.iban_bank_id = v_id;
  if c.bank_name is null then
    return query select 'IBFT'::text, v_name, v_iban, v_bname, null::text,
                        v_who || format('bank %s (%s) is not set up for iNet yet', v_id, coalesce(v_bname, '?')),
                        'iban'::text, v_behalf, v_sp;
    return;
  end if;
  return query select 'IBFT'::text, v_name, v_iban, c.bank_name, c.bank_code, null::text, 'iban'::text, v_behalf, v_sp;
end $function$;
comment on function public.inet_payee(uuid, uuid) is
  '0662/0663: the iNet file row for one employee from a bank (FT, IBFT or manual) — to the receiver in salary_payees when '
  'one is open, wallets by mobile number — or the problem that prevents one.';
revoke all on function public.inet_payee(uuid, uuid) from public, anon;
grant execute on function public.inet_payee(uuid, uuid) to authenticated;

-- 4/5. Surgery: initiate writes the new columns; release names the receiver.
do $mig$
declare v_def text; cnt int; f record;
begin
  for f in
    select * from (values
      ('public.initiate_inet_payslips(uuid,text,text,date,jsonb)',
       E'    insert into public.inet_items (batch_id, company_id, kind, payslip_id, amount, payee_name, account_no, bank_name, bank_code)\n'
       || E'    values (v_batch, b.company_id, ''payslip'', v_ps.id, round((it->>''amount'')::numeric, 0),\n'
       || E'            v_payee.payee_name, v_payee.account_no, v_payee.bank_name, v_payee.bank_code);',
       E'    -- 0663: account kind, and the guard and receiver when paid to someone else.\n'
       || E'    insert into public.inet_items (batch_id, company_id, kind, payslip_id, amount, payee_name, account_no, bank_name, bank_code,\n'
       || E'                                   account_kind, on_behalf_of, salary_payee_id)\n'
       || E'    values (v_batch, b.company_id, ''payslip'', v_ps.id, round((it->>''amount'')::numeric, 0),\n'
       || E'            v_payee.payee_name, v_payee.account_no, v_payee.bank_name, v_payee.bank_code,\n'
       || E'            v_payee.account_kind, v_payee.on_behalf_of, v_payee.salary_payee_id);',
       '0663: account kind'),
      ('public.release_inet_batch(uuid,numeric,uuid[],text)',
       E'format(''Payroll %s · %s %s (iNet: %s)'', to_char(v_ps.period_month, ''FMMonth YYYY''), v_ps.code, v_ps.full_name, bt.label)',
       E'format(''Payroll %s · %s %s (iNet: %s)%s'', to_char(v_ps.period_month, ''FMMonth YYYY''), v_ps.code, v_ps.full_name, bt.label,\n'
       || E'          case when it.on_behalf_of is not null then format('' — paid to %s'', it.payee_name) else '''' end) /* 0663 */',
       '/* 0663 */')
    ) as t(fn, anchor, repl, marker)
  loop
    v_def := pg_get_functiondef(f.fn::regprocedure);
    if position(f.marker in v_def) > 0 then raise notice '0663: % already amended.', f.fn; continue; end if;
    cnt := (length(v_def) - length(replace(v_def, f.anchor, ''))) / length(f.anchor);
    if cnt <> 1 then raise exception '0663 REFUSED: % anchor appears % times, expected 1.', f.fn, cnt; end if;
    execute replace(v_def, f.anchor, f.repl);
  end loop;
end $mig$;

-- Asserted on what can break, rolled back by a sentinel.
do $mig$
declare
  v_ps record; v_soneri uuid := 'fd247f1d-e85c-4fd3-8eb5-23fd2f1d7439'; v_askari uuid := '1df9eaa6-afdb-48d1-8f8e-8c69ba867787';
  v_w uuid; v_p record; v_sp uuid; v_res jsonb; v_it record; v_ok boolean := false; v_msg text; v_bal0 numeric; v_bal1 numeric;
begin
  begin
    perform set_config('request.jwt.claims', '{}', true);

    -- A guard on Easypaisa: Soneri writes a wallet row (code 25); Askari refuses it by name.
    select e.id into v_w from public.employees e
     where e.status = 'Active' and e.bank_name = 'Easypaisa (Wallet)'
       and regexp_replace(coalesce(e.bank_account, ''), '\D', '', 'g') ~ '^03\d{9}$'
       and not exists (select 1 from public.salary_payees s where s.employee_id = e.id and s.ended_at is null)
     order by e.id limit 1;
    if v_w is not null then
      select * into v_p from public.inet_payee(v_w, v_soneri);
      if (v_p.file_kind, v_p.bank_code, v_p.account_kind) is distinct from ('IBFT', '25', 'wallet') or v_p.problem is not null
         or v_p.account_no !~ '^03\d{9}$' then
        raise exception '0663 REFUSED: a Soneri Easypaisa row came out as % / % / % / % (problem %).',
          v_p.file_kind, v_p.bank_code, v_p.account_kind, v_p.account_no, v_p.problem;
      end if;
      select * into v_p from public.inet_payee(v_w, v_askari);
      if coalesce(v_p.problem, '') not like 'Easypaisa (Wallet) is not set up for Askari Bank iNet yet' then
        raise exception '0663 REFUSED: an Askari wallet row was not refused by name; got: %', v_p.problem;
      end if;
    end if;

    -- An unpaid October payslip, paid to someone else on Easypaisa through Soneri.
    select p.id, p.employee_id, p.net_salary, p.amount_paid, e.full_name into v_ps
      from public.payslips p join public.employees e on e.id = p.employee_id
     where p.period_month = '2026-10-01' and not p.disbursed and p.net_salary - p.amount_paid >= 1
       and not exists (select 1 from public.payroll_holds h where h.employee_id = p.employee_id and h.released_at is null)
       and not exists (select 1 from public.inet_items i where i.payslip_id = p.id and i.status = 'initiated')
     order by p.id limit 1;
    if v_ps.id is null then
      raise notice '0663: no unpaid October payslip; the paid-to test is skipped.';
    else
      -- refused without a reason, by its own message
      begin
        perform public.set_salary_payee(v_ps.employee_id, '0663 Receiver', 'Easypaisa (Wallet)', '03001234567', null, 'no');
        v_msg := '0663_NOT_REFUSED';
      exception when others then v_msg := sqlerrm; end;
      if v_msg not like 'Say why %''s salary goes to someone else.%' then
        raise exception '0663 REFUSED: a receiver without a reason was not refused; got: %', v_msg;
      end if;

      v_sp := public.set_salary_payee(v_ps.employee_id, '0663 Receiver', 'Easypaisa (Wallet)', '0300-1234567', null, '0663 test reason');
      select * into v_p from public.inet_payee(v_ps.employee_id, v_soneri);
      if (v_p.payee_name, v_p.account_no, v_p.bank_code, v_p.on_behalf_of, v_p.salary_payee_id)
         is distinct from ('0663 Receiver', '03001234567', '25', v_ps.full_name, v_sp) or v_p.problem is not null then
        raise exception '0663 REFUSED: the paid-to row came out as % / % / % / % (problem %).',
          v_p.payee_name, v_p.account_no, v_p.bank_code, v_p.on_behalf_of, v_p.problem;
      end if;

      select balance into v_bal0 from public.bank_accounts where id = v_soneri;
      v_res := public.initiate_inet_payslips(v_soneri, '0663 test', 'TEST', current_date,
                 jsonb_build_array(jsonb_build_object('payslip_id', v_ps.id, 'amount', round(v_ps.net_salary - v_ps.amount_paid))));
      select * into v_it from public.inet_items where payslip_id = v_ps.id and status = 'initiated';
      if (v_it.payee_name, v_it.on_behalf_of, v_it.account_kind, v_it.salary_payee_id, v_it.amount)
         is distinct from ('0663 Receiver', v_ps.full_name, 'wallet', v_sp, round(v_ps.net_salary - v_ps.amount_paid)) then
        raise exception '0663 REFUSED: the initiated item is % / % / % / % / %.',
          v_it.payee_name, v_it.on_behalf_of, v_it.account_kind, v_it.salary_payee_id, v_it.amount;
      end if;

      v_res := public.release_inet_batch(v_it.batch_id, round(v_ps.net_salary - v_ps.amount_paid), null, '0663 test');
      select balance into v_bal1 from public.bank_accounts where id = v_soneri;
      if v_bal0 - v_bal1 <> round(v_ps.net_salary - v_ps.amount_paid) then
        raise exception '0663 REFUSED: release moved Soneri by %, expected %.', v_bal0 - v_bal1, round(v_ps.net_salary - v_ps.amount_paid);
      end if;
      if not (select disbursed from public.payslips where id = v_ps.id) then
        raise exception '0663 REFUSED: after release the payslip is not paid.';
      end if;
      if not exists (select 1 from public.bank_transactions t
                      where t.bank_account_id = v_soneri and t.created_at >= now() - interval '1 minute'
                        and t.description like '%— paid to 0663 Receiver%') then
        raise exception '0663 REFUSED: the bank movement does not say who it was paid to.';
      end if;

      perform public.end_salary_payee(v_sp, '0663 test');
      select * into v_p from public.inet_payee(v_ps.employee_id, v_soneri);
      if v_p.on_behalf_of is not null then raise exception '0663 REFUSED: an ended receiver is still used.'; end if;
    end if;
    v_ok := true;
    raise exception '0663_SENTINEL';
  exception when others then
    if sqlerrm <> '0663_SENTINEL' then raise; end if;
  end;
  if not v_ok then raise exception '0663 REFUSED: the rolled-back test did not complete.'; end if;

  -- The rolled-back block leaves request.jwt.claims as '' — run the gap checks as the migration context.
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0663 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0663 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('set_salary_payee', 'end_salary_payee', 'inet_payee')) then
    raise exception '0663 REFUSED: branch_guard_gaps() reports one of 0663''s functions.';
  end if;
  if exists (select 1 from public.permission_key_gaps()) then raise exception '0663 REFUSED: permission_key_gaps() reports a gap.'; end if;
end $mig$;