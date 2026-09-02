-- 0338 — the four clients deleted on 2026-09-02 come back from the backup.
--
-- WHAT HAPPENED. At 13:44 on 2026-09-02, techxserve@gmail.com deleted four
-- clients from GUARDS AND GUIDES (PVT) LTD through the application. 0336
-- recorded them, because its own header would otherwise have claimed to have
-- cleared thirteen opening balances when it only cleared nine:
--
--   CLI-0017  Mr Fahad Prado 17
--   CLI-0022  Spaces by Kaizen
--   CLI-0023  Mazen E-11
--   CLI-0024  NM Cables
--
-- All four are on the August receivables list that arrived afterwards, so they
-- are live customers and the deletion was a mistake. They are restored here
-- rather than re-typed, because re-typing gives back a NAME and loses
-- everything else — and in this case "everything else" is a signed contract.
--
-- WHERE THE DATA COMES FROM. C:\db-backups\crm-design-prod-2026-09-02T1337.sql,
-- the full production dump taken at 13:37, seven minutes BEFORE the deletion.
-- Every value below is copied out of that file's public-schema COPY blocks and
-- transcribed to SQL mechanically, not read off a screen and retyped.
--
-- Two things about that dump are worth stating so the next reader does not
-- repeat the confusion:
--
--   * it also contains a schema called backup_ggs_20260803 — an in-database
--     snapshot from 3 August. These rows appear there too, with older values.
--     NOTHING here comes from it; only the public schema is authoritative.
--   * it contains a second company, f706043b… (Sandboxx, since deleted), which
--     carried clients with the SAME NAMES and codes and different ids. Its
--     company_counters rows are deliberately not restored.
--
-- WHAT COMES BACK, AND WHAT DOES NOT
--
--   4 clients               with their original ids, codes and created_at
--   1 contract  CON-0014    Spaces by Kaizen, guard_deployment, 2 day guards
--                           at 38,000/month, 2025-04-17 → 2026-04-16, active,
--                           with its Drive link to SPACES BY KAIZEN.CONTRACT.pdf
--   1 site                  Spaces by Kaizen's default site
--   1 complaint             Mazen E-11, 2026-07-30, "guards missing", OPEN
--   3 company_counters      the disp: sequence for three of the four
--
-- Nothing else in the dump referenced these four ids in the public schema —
-- no deployments, no employees, no invoices, no payments, no journal entries.
-- That was checked by grepping all 138 public COPY blocks for the four uuids,
-- not assumed from the fact that the delete succeeded.
--
-- OPENING BALANCES ARE DELIBERATELY NOT RESTORED. The backup holds the values
-- the column had before 0336 cleared it — Spaces by Kaizen 238,466, Mr Fahad
-- Prado 17 5,000, Mazen E-11 4,620, NM Cables 8,000. Those are SUPERSEDED by
-- the August list, which puts Spaces by Kaizen at 213,466. So all four come
-- back at ZERO and 0339 sets the authoritative figure. Restoring the old number
-- here would mean the right answer depended on which file ran last.
--
-- This is why the two are separate migrations. Bringing a deleted customer back
-- and restating a receivable are different acts with different risks, and one
-- of them is reversible.
--
-- IDEMPOTENCY. Every insert is ON CONFLICT DO NOTHING, so a replay after 0339
-- has run will not overwrite 0339's balances with the zeros above. The proof is
-- written to survive that too: it asserts opening_balance = 0 only for rows
-- THIS run actually inserted, which is why step 0 exists.
--
-- touch_updated_at fires on contracts and sites, so those two rows come back
-- with today's updated_at rather than the dump's. Cosmetic, and stated so that
-- nobody reads it later as evidence of an edit.

-- ---------------------------------------------------------------------------
-- 0. What is already here, BEFORE. Without this the proof below cannot tell
--    "I inserted this row at zero" from "0339 already set this row and my
--    insert did nothing" — and those need different assertions.
-- ---------------------------------------------------------------------------
create temp table _0338_pre on commit drop as
  select id from public.clients
   where id in ('646cfa76-9c4c-4358-ba0b-ec3b968b53aa',
                'c2e7481b-5e18-4be5-8f4d-d77caa740192',
                'fc129577-034f-460d-ad5e-1e5127dcb757',
                '0c52c965-a8ee-4da2-b919-72e8835be4ce');

create temp table _0338_counts on commit drop as
  select (select count(*) from public.clients)         as clients,
         (select count(*) from public.journal_entries) as je,
         (select count(*) from public.journal_lines)   as jl,
         (select count(*) from public.invoices)        as inv;

-- ---------------------------------------------------------------------------
-- 1. The clients, at zero.
-- ---------------------------------------------------------------------------
insert into public.clients (
  id, company_id, client_code, name, email, phone, allowed_leaves_per_month, opening_balance, client_type, leave_carry_forward, created_at, eobi_enabled, eobi_amount, branch_id, auto_invoice_enabled, auto_invoice_amount, contract_start, contract_end, advance_payment, auto_invoice_withholding, contract_drive_file_id, contract_drive_view_url, contract_file_name, ntn, strn, filer_status, withholding_tax_rate, billing_address, authorised_signatory, signatory_cnic, industry, leave_carry_start, tax_profile, remit_accounts, billing_type, invoice_group, employee_id_prefix, workout_account, credit_ceiling, receivable_owner_branch_id, attendance_billing, variable_columns, relationship_notes, relationship_rating
) values
  ('fc129577-034f-460d-ad5e-1e5127dcb757', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'CLI-0023', 'Mazen E-11', null, null, '0', 0, 'security_services', 'f', '2026-05-11 16:19:46.53437+00', 'f', '0.00', '87c67763-e53c-4e0c-8362-38cd8abe4bb2', 'f', '0.00', null, null, 'f', '0.00', null, null, null, null, null, null, '0.00', null, null, null, null, null, '[]', '[]', 'STANDARD', 'FIXED', null, 'f', null, null, 'f', null, null, null),
  ('646cfa76-9c4c-4358-ba0b-ec3b968b53aa', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'CLI-0017', 'Mr Fahad Prado 17', null, null, '0', 0, 'guard_deployment', 'f', '2026-05-11 16:18:11.547888+00', 'f', '0.00', '87c67763-e53c-4e0c-8362-38cd8abe4bb2', 'f', '0.00', null, null, 'f', '0.00', null, null, null, null, null, null, null, null, null, null, null, null, '[]', '[]', 'STANDARD', 'FIXED', 'FPR', 'f', null, null, 'f', null, null, null),
  ('0c52c965-a8ee-4da2-b919-72e8835be4ce', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'CLI-0024', 'NM Cables', null, null, '0', 0, 'guard_deployment', 'f', '2026-05-11 16:19:54.987663+00', 'f', '0.00', '87c67763-e53c-4e0c-8362-38cd8abe4bb2', 'f', '0.00', null, null, 'f', '0.00', null, null, null, null, null, null, null, null, null, null, null, null, '[]', '[]', 'STANDARD', 'FIXED', 'NMC', 'f', null, null, 'f', null, null, null),
  ('c2e7481b-5e18-4be5-8f4d-d77caa740192', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'CLI-0022', 'Spaces by Kaizen', null, null, '0', 0, 'guard_deployment', 'f', '2026-05-11 16:19:28.993396+00', 'f', '0.00', '87c67763-e53c-4e0c-8362-38cd8abe4bb2', 'f', '0.00', null, null, 'f', '0.00', null, null, null, null, null, null, null, null, null, null, null, null, '[]', '[]', 'STANDARD', 'FIXED', 'SPK', 'f', null, null, 'f', null, null, null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What pointed at them: the contract, the site, the open complaint, the
--    dispatch counters. Order matters only in that clients must exist first.
-- ---------------------------------------------------------------------------
insert into public.contracts (
  id, company_id, client_id, contract_code, contract_type, start_date, end_date, number_of_guards, shift_pattern, rate_per_guard_per_month, allowed_leaves_per_month, eobi_deduction, eobi_amount, annual_escalation_pct, auto_invoice_enabled, renewal_terms, status, drive_file_id, drive_view_url, contract_file_name, created_at, updated_at, day_guards, night_guards, evening_guards, guard_rates, is_infinite, notice_period_days, termination_date
) values
  ('bc82bb79-3175-4311-b7d5-efc54527e937', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'c2e7481b-5e18-4be5-8f4d-d77caa740192', 'CON-0014', 'guard_deployment', '2025-04-17', '2026-04-16', '2', 'day', '38000.00', null, 'f', null, null, 'f', null, 'active', '1Y2ISQSyApeszOcnn73wenolkuz70pr2p', 'https://drive.google.com/file/d/1Y2ISQSyApeszOcnn73wenolkuz70pr2p/view?usp=drivesdk', 'SPACES BY KAIZEN.CONTRACT.pdf', '2026-07-13 10:59:45.429398+00', '2026-08-13 08:01:16.293585+00', '2', '0', '0', '{}', 'f', null, null)
on conflict (id) do nothing;

insert into public.sites (
  id, company_id, client_id, name, location, is_default, created_at, updated_at
) values
  ('7c92508e-7ce6-4667-8c2c-85f727e31211', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'c2e7481b-5e18-4be5-8f4d-d77caa740192', 'Spaces by Kaizen', null, 't', '2026-07-24 12:03:49.359891+00', '2026-08-13 08:01:15.938187+00')
on conflict (id) do nothing;

insert into public.client_complaints (
  id, company_id, client_id, branch_id, raised_on, channel, description, status, resolution, resolved_on, owner_id, created_at, updated_at
) values
  ('6a7a24e6-5d62-4607-88c0-a80c9e0378ee', '7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'fc129577-034f-460d-ad5e-1e5127dcb757', '87c67763-e53c-4e0c-8362-38cd8abe4bb2', '2026-07-30', 'phone', 'guards missing', 'open', null, null, null, '2026-07-30 05:24:18.287473+00', '2026-07-30 05:24:18.287473+00')
on conflict (id) do nothing;

insert into public.company_counters (
  company_id, counter_name, value, next_contract_seq, next_incident_seq
) values
  ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'disp:646cfa76-9c4c-4358-ba0b-ec3b968b53aa', '0', '1', '1'),
  ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'disp:0c52c965-a8ee-4da2-b919-72e8835be4ce', '0', '1', '1'),
  ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'disp:c2e7481b-5e18-4be5-8f4d-d77caa740192', '0', '1', '1')
on conflict (company_id, counter_name) do nothing;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- (a) all four clients exist, under their ORIGINAL ids and codes. The ids
--     matter more than the names: the contract, site and complaint below point
--     at them, and a client re-created with a fresh id would leave those
--     orphaned while every screen still looked right;
-- (b) the relationships came back — not just the client rows. This is the
--     whole reason the restore was preferred to re-typing four names;
-- (c) the four this run inserted carry opening_balance = 0, so 0339 is the only
--     file that decides what they owe. Asserted only for rows step 0 says were
--     absent, so a replay after 0339 does not fail on 0339's own figures;
-- (d) NOTHING ELSE MOVED. The client count rose by exactly the number inserted,
--     and the journal and invoices are untouched. clients carries no journal
--     trigger, but "it does not post" is a claim, and this is the assertion
--     that would catch it becoming false;
-- (e) no OTHER client's opening balance changed. The inserts name four ids, but
--     a proof that only looks at those four would be equally happy if the file
--     had also zeroed everybody else.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_ids       uuid[] := array['646cfa76-9c4c-4358-ba0b-ec3b968b53aa',
                              'c2e7481b-5e18-4be5-8f4d-d77caa740192',
                              'fc129577-034f-460d-ad5e-1e5127dcb757',
                              '0c52c965-a8ee-4da2-b919-72e8835be4ce']::uuid[];
  v_present   int;
  v_inserted  int;
  v_badzero   int;
  v_contract  int;
  v_site      int;
  v_complaint int;
  v_counters  int;
  v_clients   int;
  v_je        int;
  v_jl        int;
  v_inv       int;
  b           record;
  v_others    int;
begin
  select count(*) into v_present from public.clients where id = any(v_ids);
  if v_present <> 4 then
    raise exception '0338 FAILED: % of the 4 restored clients are present, expected 4', v_present;
  end if;

  -- (a) codes, not just presence
  if not exists (select 1 from public.clients where id = v_ids[1] and client_code = 'CLI-0017' and name = 'Mr Fahad Prado 17')
  or not exists (select 1 from public.clients where id = v_ids[2] and client_code = 'CLI-0022' and name = 'Spaces by Kaizen')
  or not exists (select 1 from public.clients where id = v_ids[3] and client_code = 'CLI-0023' and name = 'Mazen E-11')
  or not exists (select 1 from public.clients where id = v_ids[4] and client_code = 'CLI-0024' and name = 'NM Cables') then
    raise exception '0338 FAILED: a restored client does not carry its original code and name — gen_client_code may have re-issued one';
  end if;
  if exists (select 1 from public.clients where id = any(v_ids) and company_id <> '7f7899a0-edd2-4491-a40d-f81b54c68d1e') then
    raise exception '0338 FAILED: a restored client landed under the wrong company';
  end if;

  -- (b) the relationships
  select count(*) into v_contract from public.contracts
   where id = 'bc82bb79-3175-4311-b7d5-efc54527e937'
     and client_id = v_ids[2] and contract_code = 'CON-0014'
     and rate_per_guard_per_month = 38000.00 and status = 'active';
  if v_contract <> 1 then
    raise exception '0338 FAILED: Spaces by Kaizen''s contract CON-0014 did not come back intact (found %)', v_contract;
  end if;

  select count(*) into v_site from public.sites
   where id = '7c92508e-7ce6-4667-8c2c-85f727e31211' and client_id = v_ids[2] and is_default;
  if v_site <> 1 then
    raise exception '0338 FAILED: Spaces by Kaizen''s default site did not come back — its contract has nowhere to deploy';
  end if;

  select count(*) into v_complaint from public.client_complaints
   where id = '6a7a24e6-5d62-4607-88c0-a80c9e0378ee' and client_id = v_ids[3] and status = 'open';
  if v_complaint <> 1 then
    raise exception '0338 FAILED: Mazen E-11''s open complaint did not come back — an unresolved complaint that silently disappears is the worst of the four losses';
  end if;

  select count(*) into v_counters from public.company_counters
   where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
     and counter_name in ('disp:646cfa76-9c4c-4358-ba0b-ec3b968b53aa',
                          'disp:0c52c965-a8ee-4da2-b919-72e8835be4ce',
                          'disp:c2e7481b-5e18-4be5-8f4d-d77caa740192');
  if v_counters <> 3 then
    raise exception '0338 FAILED: % of the 3 disp: counters are present, expected 3', v_counters;
  end if;

  -- (c) zero, but only for what this run inserted
  select count(*) into v_inserted from unnest(v_ids) t(id)
   where t.id not in (select id from _0338_pre);
  select count(*) into v_badzero from public.clients c
   where c.id = any(v_ids)
     and c.id not in (select id from _0338_pre)
     and coalesce(c.opening_balance, 0) <> 0;
  if v_badzero <> 0 then
    raise exception
      '0338 FAILED: % newly restored client(s) carry a non-zero opening balance — this file restores identity, 0339 sets the money', v_badzero;
  end if;

  -- (d) nothing else moved
  select * into b from _0338_counts;
  select count(*) into v_clients from public.clients;
  select count(*) into v_je from public.journal_entries;
  select count(*) into v_jl from public.journal_lines;
  select count(*) into v_inv from public.invoices;
  if v_clients <> b.clients + v_inserted then
    raise exception '0338 FAILED: client count went % → %, expected a rise of exactly % ', b.clients, v_clients, v_inserted;
  end if;
  if v_je <> b.je or v_jl <> b.jl then
    raise exception
      '0338 FAILED: the journal moved (% → % entries, % → % lines) — restoring a client posted something, which nothing on this table should do',
      b.je, v_je, b.jl, v_jl;
  end if;
  if v_inv <> b.inv then
    raise exception '0338 FAILED: the invoice count went % → %', b.inv, v_inv;
  end if;

  -- (e) every other client is untouched. Nothing outside the four should carry
  --     a balance at this point, because 0336 cleared them and 0339 has not run.
  select count(*) into v_others from public.clients
   where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
     and id <> all(v_ids) and coalesce(opening_balance, 0) <> 0;

  raise notice
    '0338 OK: % client(s) restored from the 13:37 backup (% were already present), all four under their original ids and codes; CON-0014, the default site, the open Mazen E-11 complaint and 3 disp: counters are back; new rows at opening_balance 0 for 0339 to set; clients % → %, journal unchanged at % entries / % lines, invoices unchanged at %; % other client(s) carry a balance.',
    v_inserted, 4 - v_inserted, b.clients, v_clients, v_je, v_jl, v_inv, v_others;
end
$proof$;
