-- Per-company UI theme (brand accent palette). One of: 'emerald' (default),
-- 'ocean', 'indigo'. Applied at runtime by overriding the --color-brand-*
-- CSS variables, so it re-themes the whole company panel for every user in
-- the company. Only SA / SSA can change it (enforced in the UI; writes go
-- through the same RLS as other companies settings updates).
alter table public.companies
  add column if not exists theme text not null default 'emerald';
