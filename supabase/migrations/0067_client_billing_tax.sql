-- 0065: Client billing/tax profile (Phase 3).
--
-- Replaces the single withholding_tax_rate with a repeatable tax_profile, and
-- adds billing_type, invoice_group, and remit_accounts. The legacy
-- withholding_tax_rate / auto_invoice_withholding columns are kept and the app
-- mirrors the first WITHHELD tax into them so existing auto-invoice logic is
-- unaffected.
--
-- tax_profile: jsonb array of
--   { name, rate, base: WHOLE_INVOICE|SPECIFIC_COMPONENT|COMPOUND,
--     direction: ADDED|WITHHELD, component? }
-- remit_accounts: jsonb array of
--   { account_title, account_number, bank_name, is_default }
--
-- client_code is already `text unique` with an auto-gen trigger (0001) — its
-- uniqueness is enforced at the DB level, so no change is needed here.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'client_billing_type') then
    create type client_billing_type as enum ('STANDARD', 'SLA');
  end if;
  if not exists (select 1 from pg_type where typname = 'client_invoice_group') then
    create type client_invoice_group as enum ('FIXED', 'VARIABLE', 'SLA');
  end if;
end$$;

alter table public.clients
  add column if not exists tax_profile    jsonb not null default '[]'::jsonb,
  add column if not exists remit_accounts jsonb not null default '[]'::jsonb,
  add column if not exists billing_type   client_billing_type not null default 'STANDARD',
  add column if not exists invoice_group  client_invoice_group not null default 'FIXED';

-- Backfill tax_profile from the existing single withholding rate so no client
-- silently loses its WHT. Only for clients that have a rate and no profile yet.
update public.clients
   set tax_profile = jsonb_build_array(
         jsonb_build_object(
           'name', 'Withholding Tax',
           'rate', withholding_tax_rate,
           'base', 'WHOLE_INVOICE',
           'direction', 'WITHHELD'
         )
       )
 where withholding_tax_rate is not null
   and withholding_tax_rate > 0
   and (tax_profile is null or tax_profile = '[]'::jsonb);

-- clients is already in the audited-tables list (0041), so tax_profile /
-- remit_accounts changes are captured in the Audit Log automatically.
