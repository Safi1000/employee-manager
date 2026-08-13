-- 0186: clone the operational half of GUARDS AND GUIDES (PVT) LTD into a new
--       company, "guards n guides".
--
-- APPLIED to production 2026-08-13. New company id:
--     f706043b-c548-4d15-b4c7-ef81f77f8d2a
-- Verified after: every table count matches the source exactly, zero rows in
-- the new org reference a parent in the old one, all 543 guard codes and 43
-- client codes are byte-identical, and the new org holds zero invoices,
-- payslips, journal entries, bank accounts, expenses, ledger accounts, audit
-- rows, or attendance dated before 2026-08-01. The source company is unchanged.
--
-- WHY
--
-- The accounting side of the live org is beyond economic repair and will be
-- re-entered by hand. Rather than unpick it, the operational data — the part
-- that is expensive to recreate and impossible to remember — is cloned into a
-- fresh company that has no accounting history at all.
--
-- WHAT TRAVELS
--
--   branches, locations              supporting rows the others point at
--   clients → sites → shift_definitions
--   contracts → contract_lines → contract_addendums
--   employees (all 541, separated included)
--   employee_salary_history          the "pay" half of Assignments & Pay
--   deployments                      the "assignments" half
--   attendance_records               ONLY from 2026-08-01 onward
--   company_counters                 so generated codes continue, not restart
--
-- WHAT DOES NOT
--
--   invoices, invoice_lines/taxes/payments, payslips, payroll_runs, advances,
--   expenses, journal_entries/lines, bank_*, cheques, chart_of_accounts,
--   accounting_periods, treasury, partners, fixed_assets, incidents, tasks,
--   inventory, guard_documents, audit_log — everything else stays behind.
--
-- COPY, NOT MOVE. The source company is never written to; it is only ever
-- SELECTed from. If the result is wrong, delete the new company and nothing
-- has been lost.
--
-- IDENTITY
--
-- Every cloned row gets a NEW uuid, because ids are globally unique primary
-- keys. Business identifiers — employee_code, guard_code, client_code,
-- contract_code, display_number — are copied VERBATIM, so GGS-00371 is still
-- GGS-00371 in the new org. That is safe: every unique index on those columns
-- is already scoped by company_id. The old→new mapping is kept in
-- org_copy_map_0186 so any row can still be traced back to its origin.
--
-- TRIGGERS ARE OFF for the duration (session_replication_role = replica).
-- This is not optional. Left on, the ~50 triggers on these tables would:
--   • gen_employee_code / gen_client_code / assign_contract_code
--       overwrite every copied code with a freshly generated one, destroying
--       the very identifiers this clone exists to preserve
--   • enforce_attendance_window / enforce_attendance_backfill
--       reject the August attendance of anyone who has since separated
--   • enforce_guard_limit
--       abort partway through on the new company's plan cap
--   • capture_salary_change
--       write a second, duplicate salary-history row per employee
--   • seed_document_checklist_on_insert, trigger_referral_bonus,
--     sync_employee_active_client, raise_vacancy_on_posting_close
--       manufacture side-effect rows that were never in the source
--   • log_audit_change
--       add ~4,600 audit entries describing an import as user edits
-- FK constraints are enforced by the insert ORDER below instead: every parent
-- is written before its children.

set session_replication_role = replica;

create table if not exists public.org_copy_map_0186 (
  entity  text not null,
  old_id  uuid not null,
  new_id  uuid not null,
  primary key (entity, old_id)
);

-- ── Generic row copier ──────────────────────────────────────────────────────
-- Builds the INSERT column list from the catalogue at run time, skipping
-- GENERATED ALWAYS columns — Postgres rejects an explicit value for those, and
-- `insert into t select (rec).*` supplies one for every column. Two columns hit
-- this: branches.kind (derived from is_head_office) and
-- contract_lines.required_on_ground (billed_qty − relief_allowance). Both are
-- pure functions of columns that ARE copied, so they recompute identically.
--
-- Doing it from the catalogue rather than hand-listing columns also means the
-- clone stays correct if a column is added to any of these tables later.
create or replace function public.clone_rows_0186(
  p_table       text,
  p_src         uuid,
  p_overrides   text,           -- body of jsonb_build_object(...), source alias is `s`
  p_joins       text default '',
  p_extra_where text default ''
) returns bigint
language plpgsql as $fn$
declare
  v_cols text;
  v_n    bigint;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table and is_generated = 'NEVER';

  execute format(
    'insert into public.%1$I (%2$s) select %2$s from (
       select (jsonb_populate_record(null::public.%1$I,
                to_jsonb(s) || jsonb_build_object(%3$s))).*
         from public.%1$I s
         join public.org_copy_map_0186 m on m.entity = %4$L and m.old_id = s.id
         %5$s
        where s.company_id = %6$L %7$s
     ) q',
    p_table, v_cols, p_overrides, p_table, p_joins, p_src, p_extra_where);

  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

do $$
declare
  v_src uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';  -- GUARDS AND GUIDES (PVT) LTD
  v_new uuid := gen_random_uuid();
  v_cut date := date '2026-08-01';                        -- attendance from here
  v_id  text;                                             -- 'id', company_id override
begin
  if exists (select 1 from public.companies where name = 'guards n guides') then
    raise exception 'A company named "guards n guides" already exists - refusing to clone twice.';
  end if;

  v_id := format('''id'', m.new_id, ''company_id'', %L::uuid', v_new);

  -- ── The company itself ────────────────────────────────────────────────────
  -- Branding, invoice template, fiscal year, guard limit and theme carry over;
  -- identity and billing linkage are reset. Stripe ids are deliberately NOT
  -- copied — two companies pointing at one subscription would corrupt billing
  -- on the next webhook.
  --
  -- company_prefix is DROPPED rather than copied, for two reasons:
  --   1. companies_company_prefix_unique (migration 0145) is GLOBAL, not
  --      per-company. Only one company may hold 'GGS', and the source holds it.
  --   2. enforce_company_prefix_lock freezes the prefix the moment any guard in
  --      the company has a permanent code — true here from the instant the 541
  --      employees land. Setting a placeholder like 'GNG' now would therefore
  --      be PERMANENT and 'GGS' could never be adopted later. Leaving it null
  --      keeps the door open: that lock only fires when the OLD value is
  --      non-null, so null → 'GGS' is still allowed afterwards.
  -- Consequence: the new org cannot mint codes for BRAND-NEW guards until a
  -- prefix is set. Copied guards keep their existing GGS-xxxxx codes verbatim.
  insert into public.companies
  select (jsonb_populate_record(null::public.companies,
           to_jsonb(c) || jsonb_build_object(
             'id',                     v_new,
             'name',                   'guards n guides',
             'created_at',             now(),
             'updated_at',             now(),
             'stripe_customer_id',     null,
             'stripe_subscription_id', null,
             'ai_credit_used',         0,
             'invoice_settings',       (c.invoice_settings - 'company_prefix')
           ))).*
    from public.companies c where c.id = v_src;

  insert into public.org_copy_map_0186(entity, old_id, new_id) values ('companies', v_src, v_new);

  -- ── Allocate every new id up front ───────────────────────────────────────
  -- Before any insert, so self-references (employees.reporting_to, attendance
  -- swap partners) resolve in one pass instead of needing a second UPDATE.
  insert into public.org_copy_map_0186(entity, old_id, new_id)
  select 'branches', id, gen_random_uuid() from public.branches where company_id = v_src
  union all select 'locations', id, gen_random_uuid() from public.locations where company_id = v_src
  union all select 'clients', id, gen_random_uuid() from public.clients where company_id = v_src
  union all select 'sites', id, gen_random_uuid() from public.sites where company_id = v_src
  union all select 'shift_definitions', id, gen_random_uuid() from public.shift_definitions where company_id = v_src
  union all select 'contracts', id, gen_random_uuid() from public.contracts where company_id = v_src
  union all select 'contract_lines', id, gen_random_uuid() from public.contract_lines where company_id = v_src
  union all select 'contract_addendums', id, gen_random_uuid() from public.contract_addendums where company_id = v_src
  union all select 'employees', id, gen_random_uuid() from public.employees where company_id = v_src
  union all select 'employee_salary_history', id, gen_random_uuid() from public.employee_salary_history where company_id = v_src
  union all select 'deployments', id, gen_random_uuid() from public.deployments where company_id = v_src
  union all select 'attendance_records', id, gen_random_uuid()
    from public.attendance_records where company_id = v_src and attendance_date >= v_cut;

  -- ── Parents before children ──────────────────────────────────────────────
  perform public.clone_rows_0186('branches',  v_src, v_id);
  perform public.clone_rows_0186('locations', v_src, v_id);

  perform public.clone_rows_0186('clients', v_src,
    v_id || ', ''branch_id'', b1.new_id, ''receivable_owner_branch_id'', b2.new_id',
    'left join public.org_copy_map_0186 b1 on b1.entity=''branches'' and b1.old_id=s.branch_id
     left join public.org_copy_map_0186 b2 on b2.entity=''branches'' and b2.old_id=s.receivable_owner_branch_id');

  perform public.clone_rows_0186('sites', v_src,
    v_id || ', ''client_id'', cm.new_id',
    'left join public.org_copy_map_0186 cm on cm.entity=''clients'' and cm.old_id=s.client_id');

  perform public.clone_rows_0186('shift_definitions', v_src,
    v_id || ', ''site_id'', sm.new_id',
    'left join public.org_copy_map_0186 sm on sm.entity=''sites'' and sm.old_id=s.site_id');

  perform public.clone_rows_0186('contracts', v_src,
    v_id || ', ''client_id'', cm.new_id',
    'left join public.org_copy_map_0186 cm on cm.entity=''clients'' and cm.old_id=s.client_id');

  perform public.clone_rows_0186('contract_lines', v_src,
    v_id || ', ''contract_id'', ctm.new_id, ''site_id'', sm.new_id',
    'left join public.org_copy_map_0186 ctm on ctm.entity=''contracts'' and ctm.old_id=s.contract_id
     left join public.org_copy_map_0186 sm  on sm.entity=''sites'' and sm.old_id=s.site_id');

  perform public.clone_rows_0186('contract_addendums', v_src,
    v_id || ', ''contract_id'', ctm.new_id, ''contract_line_id'', clm.new_id',
    'left join public.org_copy_map_0186 ctm on ctm.entity=''contracts'' and ctm.old_id=s.contract_id
     left join public.org_copy_map_0186 clm on clm.entity=''contract_lines'' and clm.old_id=s.contract_line_id');

  -- Self-references resolve from the same map, which is why every id was
  -- allocated before the first insert.
  perform public.clone_rows_0186('employees', v_src,
    v_id || ', ''client_id'', cm.new_id, ''contract_id'', ctm.new_id,
             ''contract_line_id'', clm.new_id, ''branch_id'', bm.new_id,
             ''location_id'', lm.new_id,
             ''referred_by_employee_id'', rb.new_id,
             ''reporting_to_employee_id'', rt.new_id',
    'left join public.org_copy_map_0186 cm  on cm.entity=''clients'' and cm.old_id=s.client_id
     left join public.org_copy_map_0186 ctm on ctm.entity=''contracts'' and ctm.old_id=s.contract_id
     left join public.org_copy_map_0186 clm on clm.entity=''contract_lines'' and clm.old_id=s.contract_line_id
     left join public.org_copy_map_0186 bm  on bm.entity=''branches'' and bm.old_id=s.branch_id
     left join public.org_copy_map_0186 lm  on lm.entity=''locations'' and lm.old_id=s.location_id
     left join public.org_copy_map_0186 rb  on rb.entity=''employees'' and rb.old_id=s.referred_by_employee_id
     left join public.org_copy_map_0186 rt  on rt.entity=''employees'' and rt.old_id=s.reporting_to_employee_id');

  -- ── Assignments & Pay ────────────────────────────────────────────────────
  perform public.clone_rows_0186('employee_salary_history', v_src,
    v_id || ', ''employee_id'', em.new_id',
    'join public.org_copy_map_0186 em on em.entity=''employees'' and em.old_id=s.employee_id');

  perform public.clone_rows_0186('deployments', v_src,
    v_id || ', ''guard_id'', em.new_id, ''client_id'', cm.new_id,
             ''site_id'', sm.new_id, ''contract_line_id'', clm.new_id',
    'join public.org_copy_map_0186 em on em.entity=''employees'' and em.old_id=s.guard_id
     left join public.org_copy_map_0186 cm  on cm.entity=''clients'' and cm.old_id=s.client_id
     left join public.org_copy_map_0186 sm  on sm.entity=''sites'' and sm.old_id=s.site_id
     left join public.org_copy_map_0186 clm on clm.entity=''contract_lines'' and clm.old_id=s.contract_line_id');

  -- ── Attendance, 2026-08-01 onward only ───────────────────────────────────
  perform public.clone_rows_0186('attendance_records', v_src,
    v_id || ', ''employee_id'', em.new_id, ''worked_for_client_id'', cm.new_id,
             ''branch_id'', bm.new_id, ''swap_partner_id'', sp.new_id,
             ''covering_for_guard_id'', cg.new_id',
    'join public.org_copy_map_0186 em on em.entity=''employees'' and em.old_id=s.employee_id
     left join public.org_copy_map_0186 cm on cm.entity=''clients'' and cm.old_id=s.worked_for_client_id
     left join public.org_copy_map_0186 bm on bm.entity=''branches'' and bm.old_id=s.branch_id
     left join public.org_copy_map_0186 sp on sp.entity=''employees'' and sp.old_id=s.swap_partner_id
     left join public.org_copy_map_0186 cg on cg.entity=''employees'' and cg.old_id=s.covering_for_guard_id',
    format(' and s.attendance_date >= %L::date', v_cut));

  -- ── Code counters ────────────────────────────────────────────────────────
  -- Keyed (company_id, counter_name) with no id column, so it bypasses the
  -- helper. Without these the next guard added would be handed GGS-00001 and
  -- collide with a code already in use.
  insert into public.company_counters
  select (jsonb_populate_record(null::public.company_counters,
           to_jsonb(cc) || jsonb_build_object('company_id', v_new))).*
    from public.company_counters cc where cc.company_id = v_src;

  raise notice 'Cloned into company %', v_new;
end $$;

drop function if exists public.clone_rows_0186(text, uuid, text, text, text);

set session_replication_role = default;
