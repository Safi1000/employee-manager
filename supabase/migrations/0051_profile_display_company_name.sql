-- Per-user display company name. The simplified "Company Profile" settings card
-- is now purely personal: logo (avatar_url), company name (this column), email and
-- username (full_name) all live on the user's own profile and only affect what
-- that user sees in the app shell — they do not change the company record or what
-- other users see.
alter table public.profiles
  add column if not exists display_company_name text;
