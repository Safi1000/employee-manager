-- 0230 — Hoist remuneration basis from partner grain to company policy.
--
-- NOT APPLIED. Approved pending Shayan's sign-off, since it touches how partner
-- remuneration is measured. It ADDS and BACKFILLS only — nothing is dropped
-- here, so no existing reader of partners.basis breaks. See the foot of the file
-- for where the drop lives and why it is not here.
--
-- Why the column is wrong: it is not that per-partner basis is a bad idea, it is
-- that basis is COMPANY POLICY stored at PARTNER grain. Part A already settled
-- it — regional partner shares run on cash basis by design. One rule for the
-- whole company, stored once per partner, gives N places to diverge and zero
-- that are authoritative.
--
-- Nothing commercial is removed. Basis was never negotiated per partner; it was
-- recorded per partner by accident. The actual terms — Safi 15%, Shayan 20% —
-- live in profit_share_percent and partner_client_shares and are untouched.
--
-- The assert is the point of this migration, not the column drop. If any company
-- has partners whose basis disagrees today, that is a live data problem and the
-- migration must surface it rather than silently collapse it to a single value.

alter table public.finance_settings
  add column if not exists partner_remuneration_basis text not null default 'cash';

do $$ begin
  alter table public.finance_settings
    add constraint finance_settings_partner_basis_chk
    check (partner_remuneration_basis in ('cash', 'revenue'));
exception when duplicate_object then null; end $$;

comment on column public.finance_settings.partner_remuneration_basis is
  'Basis on which regional partner remuneration is computed, for the whole company (A9). Hoisted from partners.basis in 0230 — basis is a property of how the report is drawn, not of who the partner is.';

-- Refuse to collapse a real disagreement.
do $$
declare r record;
begin
  for r in
    select p.company_id, c.name as company,
           array_agg(distinct lower(p.basis)) filter (where p.basis is not null) as bases
      from public.partners p
      join public.companies c on c.id = p.company_id
     where p.scope = 'BRANCH'
     group by p.company_id, c.name
  loop
    if r.bases is not null and array_length(r.bases, 1) > 1 then
      raise exception
        'Company % has regional partners on disagreeing bases (%) — resolve before hoisting to company policy',
        r.company, array_to_string(r.bases, ', ')
        using errcode = '23514';
    end if;
  end loop;
end $$;

-- Backfill from whatever the partners agreed on; default stays 'cash' where a
-- company has no regional partners or none carried a basis.
update public.finance_settings fs
   set partner_remuneration_basis = sub.b
  from (
    select p.company_id, min(lower(p.basis)) as b
      from public.partners p
     where p.scope = 'BRANCH' and p.basis is not null
     group by p.company_id
  ) sub
 where fs.company_id = sub.company_id
   and fs.partner_remuneration_basis is distinct from sub.b;

insert into public.finance_settings (company_id)
select id from public.companies
on conflict (company_id) do nothing;

-- The column drop is NOT here, and is NOT commented out here.
--
-- Section 5.1 is answered — basis is company policy, not a partner attribute —
-- but two functions still READ partners.basis: partnership_allocation (3 sites)
-- and partner_client_breakdown (2 sites). Repointing partnership_allocation at a
-- single company basis IS the section 1 defect fix in
-- docs/LEDGER_PHASE1_F41_DEFECT_RECORD.md, and that belongs with the F4 work
-- rather than smuggled into a hoist.
--
-- So the drop is migration 0232, with a stated date, rather than a commented-out
-- statement sitting here waiting for someone to notice it. A commented-out
-- statement is not a plan; it is a note that outlives whoever wrote it.
--
-- Until 0232 applies, partners.basis is REDUNDANT but not stale: the assert
-- above guarantees it agrees with finance_settings for every company, so a
-- reader of either gets the same answer. That is what makes the two-step safe.
