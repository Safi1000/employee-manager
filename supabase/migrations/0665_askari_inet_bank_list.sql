-- 0665 — Askari iNet bank names for every bank and wallet our payees use
--
-- From Askari iNet's own bank list (Single Instruction Input ▸ bank drop-down,
-- screenshots shared by Shayan 12 Nov 2026), spelled exactly as iNet shows
-- them. iNet matches the NAME (0662); the code column is not what it checks,
-- so the code is the bank's number in Soneri's list — a placeholder, as in 0664.
-- Banks whose IBAN id or wallet is not certain are left out and stay refused by
-- name: HBL Konnect (HBL or HBL Microfinance?), UBL Omni, UPaisa, Zindigi,
-- Bank of AJK (not on the list; its guards have no IBAN).

insert into public.inet_bank_codes (inet_format, iban_bank_id, bank_name, bank_code) values
  ('askari', 'FAYS', 'Faysal Bank Limited', '12'),
  ('askari', 'JSBL', 'JS Bank', '14'),
  ('askari', 'AIIN', 'Al Baraka Bank Limited', '26'),
  ('askari', 'BKIP', 'BankIslami Pakistan Limited', '24'),
  ('askari', 'BPUN', 'Bank of Punjab', '18'),
  ('askari', 'KHYB', 'Bank of Khyber', '33'),
  ('askari', 'DUIB', 'Dubai Islamic Bank Pakistan Limited', '3'),
  ('askari', 'SCBL', 'Standard Chartered Bank', '2'),
  ('askari', 'MCIB', 'MCB Islamic Banking', '31'),
  ('askari', 'SAUD', 'Silk Bank', '21'),
  ('askari', 'SIND', 'Sindh Bank', '4'),
  ('askari', 'CITI', 'CitiBank', '5')
on conflict (inet_format, iban_bank_id) do update set bank_name = excluded.bank_name, bank_code = excluded.bank_code;

insert into public.inet_wallet_codes (inet_format, wallet_name, bank_name, bank_code) values
  ('askari', 'JazzCash (Wallet)', 'Mobilink Microfinance Bank Limited', '32'),
  ('askari', 'JazzCash (Mobilink Microfinance Bank)', 'Mobilink Microfinance Bank Limited', '32'),
  ('askari', 'NayaPay (Wallet)', 'NAYAPAY', '53'),
  ('askari', 'SadaPay (Wallet)', 'SADAPAY', '52')
on conflict (inet_format, wallet_name) do update set bank_name = excluded.bank_name, bank_code = excluded.bank_code;

do $mig$
begin
  if (select count(*) from public.inet_bank_codes where inet_format = 'askari') < 21
     or (select count(*) from public.inet_wallet_codes where inet_format = 'askari') < 5 then
    raise exception '0665 REFUSED: the Askari names did not all land.';
  end if;
end $mig$;