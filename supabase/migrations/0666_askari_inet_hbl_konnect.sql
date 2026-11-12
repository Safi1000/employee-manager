-- 0666 — Askari iNet name for HBL Konnect wallets
--
-- Shayan, 12 Nov 2026: an HBL Konnect (mobile-number) payee is keyed in iNet
-- as "HBL Microfinance Bank Limited" (on iNet's bank list). Code: placeholder,
-- as in 0664/0665 — iNet matches the name.

insert into public.inet_wallet_codes (inet_format, wallet_name, bank_name, bank_code)
values ('askari', 'HBL Konnect (Wallet)', 'HBL Microfinance Bank Limited', '0')
on conflict (inet_format, wallet_name) do update set bank_name = excluded.bank_name, bank_code = excluded.bank_code;