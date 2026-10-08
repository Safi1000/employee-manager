-- 0509 — 68 HS, PCI and PFM are one client, "68 HS-PCI-PFM", with three sites.
--
-- DECIDED (2026-10-08, Shayan): the three clients are the same person. They
-- become ONE client with ONE contract, and the three former clients become
-- that contract's three sites. Billing as one starts in October. Receivables
-- are merged in full. The ledger is NOT re-tagged.
--
-- THE SHAPE.
--   * PCI is renamed "68 HS-PCI-PFM" and takes the new prefix 68HPP. 68 HS and
--     PFM move into it. PCI was the largest (39 guards), so its history stays
--     attached without moving.
--   * PCI's contract, CON-0009, IS the merged contract. A brand-new contract
--     dated 1 October was the first plan and is wrong: a guard's attendance
--     window is his contract's dates (attendanceWindowError, and
--     enforce_attendance_backfill), so every guard moved onto it would read X
--     for all of September — a month still in payroll review — and could not
--     be corrected. Billing periods come from the contract's start
--     (contract_periods), so the start cannot be backdated without billing the
--     past either. CON-0009 already covers 1 Aug 2024 onward.
--   * 68 HS's and PFM's lines are copied onto CON-0009 at their own sites, at
--     the same rates and headcounts; PCI's own lines are pinned to the PCI
--     site. Their old contracts (CON-0022, CON-0030) end 30 Sep 2026 and are
--     kept for the invoices already billed on them — one primary invoice per
--     contract per period (uq_invoice_contract_period) means September's three
--     invoices cannot share a contract.
--   * Everything operational follows the client: employees, deployments (open
--     ones onto the new lines), attendance, confirmations, overrides, remarks,
--     daily reports, verifications, payroll stages, advances, expenses,
--     invoices, payments, reviews, renewals.
--   * Every guard's DISPLAY code changes, because a display code is the
--     client's prefix plus a per-client number (guardDisplayCode). PCI's
--     guards keep their numbers under 68HPP; 68 HS's and then PFM's guards are
--     numbered on from PCI's counter. Permanent GGS- codes do not change.
--
-- THE LEDGER. journal_lines are immutable and are not touched. Two triggers
-- would otherwise re-post on a client change — journal_on_invoice and
-- journal_on_advance reverse and re-post under the new client — which is
-- re-tagging by another route. They are disabled for the move only. Instead
-- ONE transfer entry moves every receivable balance carried by 68 HS and PFM
-- (ar, employee_advances_receivable, wht_receivable) onto the merged client,
-- dated today in the open month. Revenue and cost lines stay on their
-- original clients: that is history, not a balance.
--
-- KNOWN EDGE. If a September invoice of 68 HS or PFM is later EDITED in a way
-- that re-posts it (amount, dates), its reversal will be tagged with the old
-- client and the new posting with the merged one, leaving an equal and
-- opposite figure on the two. A re-post of a pre-merge row is the one thing
-- this migration cannot make clean.
--
-- COLLISIONS. Tables allowing one row per client per period (half-month and
-- month verifications, payroll stages, daily reports) collapse to one. For
-- the verification-shaped ones the rows are compared first and the migration
-- REFUSES if the three clients sit at different stages, rather than choosing.
-- Daily reports on the same date are combined, each labelled with its site.
--
-- The old 68 HS and PFM clients stay — their ledger lines reference them — but
-- with nothing on them, and are renamed so no one picks them.

do $mig$
declare
  c_m uuid := 'c528cb54-89b2-4ec3-b62c-0833fb1a9033';  -- PCI → 68 HS-PCI-PFM
  c_a uuid := 'a4553963-0772-42aa-9589-de7217b691c8';  -- 68 HS
  c_f uuid := '4288ef93-dd35-408a-840d-407544d14140';  -- PFM
  k_m uuid := 'a6fc92cc-9d22-42a4-a0ce-7de1876d71e8';  -- CON-0009, the merged contract
  k_a uuid := '9d947603-8d3c-44e2-b488-9cc293986220';  -- CON-0022
  k_f uuid := 'fe9a66db-0626-4c49-a728-c44789159ded';  -- CON-0030
  s_m uuid := '828fd7ff-eae6-446b-bec2-ac30bfdb5bc4';  -- site PCI
  s_a uuid := 'e4184474-5e1a-4643-a52e-2b5675c1d500';  -- site 68 HS
  s_f uuid := '5310ff9c-cc36-4286-9f65-4501427520df';  -- site PFM
  v_co     uuid;
  v_branch uuid;
  r        record;
  m        record;
  v_new    uuid;
  v_n      int;
  v_keep   uuid;
  v_text   text;
  v_norep  boolean;
  v_lines  jsonb := '[]'::jsonb;
begin
  if (select name from public.clients where id = c_m) = '68 HS-PCI-PFM'
     and not exists (select 1 from public.employees where client_id in (c_a, c_f)) then
    raise notice '0509: already merged — nothing to do.';
    return;
  end if;

  select company_id, branch_id into v_co, v_branch from public.clients where id = c_m;
  if (select name from public.clients where id = c_m) <> 'PCI'
     or (select name from public.clients where id = c_a) <> '68 HS'
     or (select name from public.clients where id = c_f) <> 'PFM' then
    raise exception '0509: the three clients are not the PCI / 68 HS / PFM this file was written against. Nothing changed.';
  end if;
  if (select count(*) from public.contracts where (id, client_id) in ((k_m, c_m), (k_a, c_a), (k_f, c_f))) <> 3 then
    raise exception '0509: CON-0009 / CON-0022 / CON-0030 no longer belong to PCI / 68 HS / PFM. Nothing changed.';
  end if;

  -- Maintenance session: the attendance, period and finance-verify locks stand
  -- aside, and enforce_reliever keeps the client written here instead of
  -- re-deriving each historical row's site. Contract amendment: the line and
  -- headcount locks on an Active contract stand aside for the copy below.
  perform set_config('app.ledger_maintenance', 'on', true);
  perform set_config('app.contract_amendment', '1', true);

  -- ---------------------------------------------------------------------------
  -- 1. THE CLIENT. Opening receivables are summed onto the merged client
  --    (ar_sub in ledger_checks_base reads the company total, so it is
  --    unchanged).
  -- ---------------------------------------------------------------------------
  update public.clients
     set name = '68 HS-PCI-PFM',
         employee_id_prefix = '68HPP',
         opening_balance = (select sum(coalesce(opening_balance, 0)) from public.clients where id in (c_m, c_a, c_f))
   where id = c_m;
  update public.clients
     set opening_balance = 0,
         name = name || ' (merged into 68 HS-PCI-PFM)'
   where id in (c_a, c_f);

  -- ---------------------------------------------------------------------------
  -- 2. THE SITES. PCI's stays the default.
  -- ---------------------------------------------------------------------------
  update public.sites set client_id = c_m, is_default = false where id in (s_a, s_f);

  -- ---------------------------------------------------------------------------
  -- 3. THE CONTRACT. PCI's lines are pinned to the PCI site; 68 HS's and PFM's
  --    lines are copied onto CON-0009 at their own sites, unchanged otherwise.
  -- ---------------------------------------------------------------------------
  update public.contract_lines set site_id = s_m where contract_id = k_m and site_id is null;

  create temp table _0509_line_map (old_id uuid primary key, new_id uuid not null) on commit drop;
  for r in
    select l.*, case l.contract_id when k_a then s_a else s_f end as to_site
      from public.contract_lines l
     where l.contract_id in (k_a, k_f)
     order by l.contract_id, l.created_at
  loop
    insert into public.contract_lines
      (company_id, contract_id, category, label, location, committed_count, unit_rate,
       cost_components, taxable, site_id, shift_code, billed_qty, relief_allowance,
       relief_mode, billing_rate, client_ot_rate)
    values
      (r.company_id, k_m, r.category, r.label, r.location, r.committed_count, r.unit_rate,
       r.cost_components, r.taxable, r.to_site, r.shift_code, r.billed_qty, r.relief_allowance,
       r.relief_mode, r.billing_rate, r.client_ot_rate)
    returning id into v_new;
    insert into _0509_line_map values (r.id, v_new);
  end loop;

  update public.contracts k
     set number_of_guards = coalesce(k.number_of_guards, 0)
                          + (select coalesce(sum(number_of_guards), 0) from public.contracts where id in (k_a, k_f)),
         day_guards       = coalesce(k.day_guards, 0)
                          + (select coalesce(sum(day_guards), 0) from public.contracts where id in (k_a, k_f)),
         night_guards     = coalesce(k.night_guards, 0)
                          + (select coalesce(sum(night_guards), 0) from public.contracts where id in (k_a, k_f))
   where k.id = k_m;

  update public.contracts
     -- A notice period exists only on an open-ended contract
     -- (contracts_notice_period_days_check), so ending one clears it.
     set client_id = c_m, end_date = date '2026-09-30', is_infinite = false,
         notice_period_days = null, status = 'expired'
   where id in (k_a, k_f);

  -- ---------------------------------------------------------------------------
  -- 4. EMPLOYEES. 68 HS's first, then PFM's, each in their old number order, so
  --    the new 68HPP numbers keep their relative order.
  -- ---------------------------------------------------------------------------
  for r in
    select id from public.employees
     where client_id in (c_a, c_f)
     order by (client_id = c_f), display_number nulls last, employee_code
  loop
    update public.employees e
       set client_id = c_m,
           display_number = null,
           contract_line_id = coalesce((select new_id from _0509_line_map where old_id = e.contract_line_id), e.contract_line_id)
     where e.id = r.id;
    perform public.assign_display_number(r.id);
  end loop;
  -- Anyone else still pointing at an old line (one inactive PCI guard does).
  update public.employees e
     set contract_line_id = mp.new_id
    from _0509_line_map mp
   where e.contract_line_id = mp.old_id;

  -- ---------------------------------------------------------------------------
  -- 5. DEPLOYMENTS. All move client; open ones move onto the new lines.
  -- ---------------------------------------------------------------------------
  update public.deployments d
     set client_id = c_m,
         contract_line_id = case
           when d.end_date is null or d.end_date >= date '2026-10-01'
             then coalesce((select new_id from _0509_line_map where old_id = d.contract_line_id), d.contract_line_id)
           else d.contract_line_id end
   where d.client_id in (c_a, c_f);

  -- ---------------------------------------------------------------------------
  -- 6. ATTENDANCE and everything keyed to it.
  -- ---------------------------------------------------------------------------
  update public.attendance_records       set worked_for_client_id = c_m where worked_for_client_id in (c_a, c_f);
  update public.attendance_confirmations set client_id = c_m where client_id in (c_a, c_f);
  update public.attendance_overrides     set client_id = c_m where client_id in (c_a, c_f);
  update public.attendance_board_remarks set client_id = c_m where client_id in (c_a, c_f);

  for r in select * from public.attendance_half_verifications where client_id in (c_a, c_f) loop
    select * into m from public.attendance_half_verifications
     where client_id = c_m and period_month = r.period_month and half = r.half
       and branch_id is not distinct from r.branch_id;
    if found then
      if (m.hr_verified_at is null) <> (r.hr_verified_at is null)
         or (m.ops_verified_at is null) <> (r.ops_verified_at is null) then
        raise exception '0509: % half % is at a different verification stage for one of the three clients — stopping rather than choosing.',
          to_char(r.period_month, 'Mon YYYY'), r.half;
      end if;
      delete from public.attendance_half_verifications where id = r.id;
    else
      update public.attendance_half_verifications set client_id = c_m where id = r.id;
    end if;
  end loop;

  for r in select * from public.attendance_month_verifications where client_id in (c_a, c_f) loop
    if exists (select 1 from public.attendance_month_verifications
                where client_id = c_m and period_month = r.period_month) then
      delete from public.attendance_month_verifications where id = r.id;
    else
      update public.attendance_month_verifications set client_id = c_m where id = r.id;
    end if;
  end loop;

  for r in select * from public.payroll_run_phases where client_id in (c_a, c_f) loop
    select * into m from public.payroll_run_phases where client_id = c_m and period_month = r.period_month;
    if found then
      if m.phase is distinct from r.phase
         or (m.finance_verified_at is null) <> (r.finance_verified_at is null) then
        raise exception '0509: payroll for % is at a different stage for one of the three clients — stopping rather than choosing.',
          to_char(r.period_month, 'Mon YYYY');
      end if;
      delete from public.payroll_run_phases where id = r.id;
    else
      update public.payroll_run_phases set client_id = c_m where id = r.id;
    end if;
  end loop;

  -- Daily client reports: one per client per date. Same-date reports are
  -- combined into one, each part labelled with the site it came from.
  for r in
    select report_date from public.daily_client_reports
     where client_id in (c_m, c_a, c_f)
     group by report_date
    having bool_or(client_id in (c_a, c_f))
  loop
    select id into v_keep from public.daily_client_reports
     where client_id in (c_m, c_a, c_f) and report_date = r.report_date
     order by (client_id = c_m) desc, created_at
     limit 1;
    select count(*),
           string_agg(case client_id when c_a then '68 HS' when c_m then 'PCI' else 'PFM' end
                      || ': ' || btrim(details), E'\n'
                      order by case client_id when c_a then 1 when c_m then 2 else 3 end)
             filter (where nullif(btrim(details), '') is not null),
           bool_and(coalesce(no_report, false))
      into v_n, v_text, v_norep
      from public.daily_client_reports
     where client_id in (c_m, c_a, c_f) and report_date = r.report_date;
    delete from public.daily_client_reports
     where client_id in (c_m, c_a, c_f) and report_date = r.report_date and id <> v_keep;
    if v_n > 1 then
      update public.daily_client_reports
         set client_id = c_m, details = v_text, no_report = v_norep
       where id = v_keep;
    else
      update public.daily_client_reports set client_id = c_m where id = v_keep;
    end if;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 7. EVERYTHING ELSE THAT NAMES THE CLIENT.
  -- ---------------------------------------------------------------------------
  update public.client_service_reviews set client_id = c_m where client_id in (c_a, c_f);
  update public.renewal_pipeline       set client_id = c_m where client_id in (c_a, c_f);
  update public.supervisor_visits      set client_id = c_m where client_id in (c_a, c_f);
  update public.vacancies              set client_id = c_m where client_id in (c_a, c_f);
  update public.roster_assignments     set client_id = c_m where client_id in (c_a, c_f);
  update public.posts                  set client_id = c_m where client_id in (c_a, c_f);

  -- ---------------------------------------------------------------------------
  -- 8. RECEIVABLES, without re-tagging the ledger. The re-posting triggers are
  --    off for the move only; the approval lock is off because an approved
  --    expense refuses any client change, and this is not an edit of it.
  -- ---------------------------------------------------------------------------
  alter table public.invoices disable trigger trg_yyy_invoices_journal;
  update public.invoices set client_id = c_m where client_id in (c_a, c_f);
  alter table public.invoices enable trigger trg_yyy_invoices_journal;

  update public.invoice_payments set client_id = c_m where client_id in (c_a, c_f);

  alter table public.advances disable trigger trg_yyy_advances_journal;
  update public.advances set client_id = c_m where client_id in (c_a, c_f);
  alter table public.advances enable trigger trg_yyy_advances_journal;

  alter table public.expenses disable trigger trg_expense_approval_lock;
  update public.expenses set client_id = c_m where client_id in (c_a, c_f);
  alter table public.expenses enable trigger trg_expense_approval_lock;

  -- One transfer entry: every receivable balance 68 HS and PFM carry in the
  -- ledger moves to the merged client, per employee where the account has one.
  if not exists (select 1 from public.journal_entries
                  where company_id = v_co and source_table = 'client_merge' and source_id = c_m) then
    for r in
      select jl.client_id, a.system_key, jl.employee_id, sum(jl.debit - jl.credit) as bal
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
        join public.chart_of_accounts a on a.id = jl.account_id
       where je.company_id = v_co
         and jl.client_id in (c_a, c_f)
         and a.system_key in ('ar', 'employee_advances_receivable', 'wht_receivable')
       group by 1, 2, 3
      having sum(jl.debit - jl.credit) <> 0
    loop
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('key', r.system_key, 'client_id', r.client_id, 'employee_id', r.employee_id,
                           'debit', greatest(-r.bal, 0), 'credit', greatest(r.bal, 0)),
        jsonb_build_object('key', r.system_key, 'client_id', c_m, 'employee_id', r.employee_id,
                           'debit', greatest(r.bal, 0), 'credit', greatest(-r.bal, 0)));
    end loop;
    if jsonb_array_length(v_lines) > 0 then
      perform public.post_journal(
        v_co, current_date,
        'Client merge (0509): receivables of 68 HS and PFM moved to 68 HS-PCI-PFM',
        'client_merge', c_m, false, v_lines, v_branch);
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- 9. NOTHING IS LEFT ON THE OLD CLIENTS except the ledger lines and the
  --    renumbering history that are meant to stay.
  -- ---------------------------------------------------------------------------
  select count(*) into v_n from (
    select 1 from public.employees where client_id in (c_a, c_f)
    union all select 1 from public.deployments where client_id in (c_a, c_f)
    union all select 1 from public.attendance_records where worked_for_client_id in (c_a, c_f)
    union all select 1 from public.invoices where client_id in (c_a, c_f)
    union all select 1 from public.invoice_payments where client_id in (c_a, c_f)
    union all select 1 from public.sites where client_id in (c_a, c_f)
    union all select 1 from public.contracts where client_id in (c_a, c_f)
  ) z;
  if v_n <> 0 then
    raise exception '0509: % row(s) still sit on 68 HS or PFM after the move.', v_n;
  end if;
end $mig$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0509 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
