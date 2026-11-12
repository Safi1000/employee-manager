-- 0664 — Askari iNet names for Easypaisa wallets and Habib Metro
--
-- From Askari's own approval exports (Ins_Approval_*.xlsx, shared by Shayan
-- 12 Nov 2026): an Easypaisa payment to a mobile number shows BANKNAME
-- "Telenor Bank"; Habib Metro shows "Habib Metropolitan Bank Limited".
-- iNet matches the NAME (0662's finding); the code column is not what it
-- checks, and neither bank appears in an accepted bulk file, so the code is
-- the bank's number in Soneri's list (25, 20) — a placeholder, watch the first
-- row through. Approved by Shayan 12 Nov 2026, named.

insert into public.inet_wallet_codes (inet_format, wallet_name, bank_name, bank_code)
values ('askari', 'Easypaisa (Wallet)', 'Telenor Bank', '25')
on conflict (inet_format, wallet_name) do update set bank_name = excluded.bank_name, bank_code = excluded.bank_code;

insert into public.inet_bank_codes (inet_format, iban_bank_id, bank_name, bank_code)
values ('askari', 'MPBL', 'Habib Metropolitan Bank Limited', '20')
on conflict (inet_format, iban_bank_id) do update set bank_name = excluded.bank_name, bank_code = excluded.bank_code;

do $mig$
begin
  if (select bank_name from public.inet_wallet_codes where inet_format = 'askari' and wallet_name = 'Easypaisa (Wallet)') is distinct from 'Telenor Bank'
     or (select bank_name from public.inet_bank_codes where inet_format = 'askari' and iban_bank_id = 'MPBL') is distinct from 'Habib Metropolitan Bank Limited' then
    raise exception '0664 REFUSED: the two names did not land.';
  end if;
end $mig$;