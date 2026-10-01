-- 0488 — vendors carry their bank details: bank name, account title, branch code.
--
-- account_number already existed (stored so it can be copy-pasted when paying the
-- vendor from a banking app). The other three are what a bank transfer form asks
-- for alongside it. Filled from Expenses ▸ Manage Vendors (web and mobile) and
-- shown on the Accounts Payable pay screen, so this is not a column nobody can
-- reach: both screens land in the same change.
--
-- TENANT GUARD ASSERTION NOT APPLICABLE: this adds three nullable text columns to
-- an existing table and creates or alters no function; vendors' company_members
-- RLS policy already scopes every row, new columns included.

alter table public.vendors add column if not exists bank_name     text;
alter table public.vendors add column if not exists account_title text;
alter table public.vendors add column if not exists branch_code   text;

comment on column public.vendors.bank_name     is 'Vendor''s bank, shown when paying them (Accounts Payable). Entered in Manage Vendors.';
comment on column public.vendors.account_title is 'Title of the vendor''s bank account, shown when paying them. Entered in Manage Vendors.';
comment on column public.vendors.branch_code   is 'Vendor''s bank branch code, shown when paying them. Entered in Manage Vendors.';
