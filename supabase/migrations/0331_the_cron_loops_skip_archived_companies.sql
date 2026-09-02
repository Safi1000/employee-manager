-- 0331 — the scheduled jobs skip archived companies.
--
-- WHY THIS EXISTS SEPARATELY FROM THE DELETE. 0329 made an archived company's
-- records read-only, enforced by a trigger on 129 tables. Nothing taught the
-- five cron jobs about it. SANDBOX TESTING ORG was the archived company on
-- production when that was found, and deleting it removed today's instance
-- without fixing anything: the next company anyone archives brings the whole
-- problem straight back. This file is that fix, and it is deliberately not
-- folded into 0330 — a payroll lock and a set of cron loops are different
-- subjects with different risks, and bundling them would mean one review for
-- two things.
--
-- THE THREE THAT BREAK, AND HOW
--
--   run_scheduled_ledger_checks     05:00 daily
--     Loops `where c.active` and writes notification_deliveries and alerts per
--     company. For an archived company every one of those writes is refused.
--     Its exception handler then tries to record the failure — in
--     notification_deliveries, which is refused for the same reason — so the
--     run ends at `raise warning`, reaching only the postgres log. That is
--     precisely the silent failure the function's own comment says it exists
--     to prevent.
--
--   generate_fixed_expense_instances  00:05 on the 1st
--     One INSERT ... SELECT across every company, and NO exception handler.
--     A single archived company with an active fixed expense aborts the whole
--     monthly run, for everybody.
--
--   run_auto_invoices               02:00 on the 1st
--     Same shape: a loop over clients with no exception handler. One archived
--     company's auto-invoice client would abort the monthly invoice run for
--     every other company.
--
-- THE TWO THAT ARE LEFT ALONE, STATED SO THE OMISSION IS NOT MISTAKEN FOR AN
-- OVERSIGHT
--
--   enforce_subscription_expiry     01:00 daily
--     Writes only to public.companies, which carries no 0329 trigger, so it
--     does not fail. Deactivating an archived company whose subscription has
--     lapsed is harmless and arguably correct. Changed nothing.
--
--   invoke_send_compliance_alerts   06:00 daily
--     Posts to an edge function and returns a request id. The per-company work
--     happens in TypeScript, outside this database, so the filter belongs
--     there and cannot be added here. Logged as outstanding in
--     docs/PRODUCTION_CLEANUP.md rather than half-done here.
--
-- SURGERY, NOT RESTATEMENT, FOR ALL THREE. run_auto_invoices has eight authors
-- and generate_fixed_expense_instances has two, so CLAUDE.md forbids restating
-- them outright. run_scheduled_ledger_checks has exactly one (0301) and could
-- have been restated behind a digest — but the change is a one-line filter, and
-- surgery against the live definition is the safer form of the same edit, so
-- all three are done the same way. Each anchor is asserted to appear exactly
-- once; if it does not, the migration refuses rather than widening the pattern
-- until it matches.
--
-- The patterns tolerate \r, because the same function can carry CRLF on one
-- database and LF on the other — 0330 met exactly that with
-- enforce_finance_verify_lock.

-- ---------------------------------------------------------------------------
-- 1. run_scheduled_ledger_checks
-- ---------------------------------------------------------------------------
do $one$
declare
  v_src  text;
  v_hits int;
  v_pat  constant text := 'where c\.active loop';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='run_scheduled_ledger_checks';
  if v_src is null then
    raise exception '0331 FAILED: public.run_scheduled_ledger_checks does not exist';
  end if;

  if position('archived_at' in v_src) > 0 then
    raise notice '0331: run_scheduled_ledger_checks already reads archived_at, leaving it alone';
    return;
  end if;

  v_hits := (select count(*) from regexp_matches(v_src, v_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0331 FAILED: the company-loop anchor appears % times in run_scheduled_ledger_checks, expected exactly 1 — do not guess where the filter belongs', v_hits;
  end if;

  v_src := regexp_replace(v_src, v_pat,
    'where c.active and c.archived_at is null loop  -- 0331: an archived company''s writes are all refused, including the failure row the handler writes');
  execute v_src;
end
$one$;

-- ---------------------------------------------------------------------------
-- 2. generate_fixed_expense_instances
-- ---------------------------------------------------------------------------
do $two$
declare
  v_src  text;
  v_hits int;
  v_pat  constant text := 'and \(v_company is null or f\.company_id = v_company\)';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='generate_fixed_expense_instances';
  if v_src is null then
    raise exception '0331 FAILED: public.generate_fixed_expense_instances does not exist';
  end if;

  if position('archived_at' in v_src) > 0 then
    raise notice '0331: generate_fixed_expense_instances already reads archived_at, leaving it alone';
    return;
  end if;

  v_hits := (select count(*) from regexp_matches(v_src, v_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0331 FAILED: the company-scope anchor appears % times in generate_fixed_expense_instances, expected exactly 1', v_hits;
  end if;

  v_src := regexp_replace(v_src, v_pat,
    'and (v_company is null or f.company_id = v_company)' || E'\n' ||
    '    -- 0331. This statement has no exception handler: one archived company' || E'\n' ||
    '    -- with an active fixed expense would abort the whole monthly run.' || E'\n' ||
    '    and not exists (select 1 from public.companies co' || E'\n' ||
    '                     where co.id = f.company_id and co.archived_at is not null)');
  execute v_src;
end
$two$;

-- ---------------------------------------------------------------------------
-- 3. run_auto_invoices
-- ---------------------------------------------------------------------------
do $three$
declare
  v_src  text;
  v_hits int;
  v_pat  constant text := 'and c\.company_id is not null';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='run_auto_invoices';
  if v_src is null then
    raise exception '0331 FAILED: public.run_auto_invoices does not exist';
  end if;

  if position('archived_at' in v_src) > 0 then
    raise notice '0331: run_auto_invoices already reads archived_at, leaving it alone';
    return;
  end if;

  v_hits := (select count(*) from regexp_matches(v_src, v_pat, 'g'));
  if v_hits <> 1 then
    raise exception
      '0331 FAILED: the client-loop anchor appears % times in run_auto_invoices, expected exactly 1', v_hits;
  end if;

  v_src := regexp_replace(v_src, v_pat,
    'and c.company_id is not null' || E'\n' ||
    '       -- 0331. No exception handler here either: one archived company''s' || E'\n' ||
    '       -- auto-invoice client would abort the monthly run for everybody.' || E'\n' ||
    '       and not exists (select 1 from public.companies co' || E'\n' ||
    '                        where co.id = c.company_id and co.archived_at is not null)');
  execute v_src;
end
$three$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- STATIC: each of the three now reads companies.archived_at exactly once, and
-- each still carries a marker from its own body, so a surgery that replaced
-- more than the anchor is caught.
--
-- Every count below is a DELTA against a baseline taken just before the jobs
-- run. Totals would be wrong on any database that has run these jobs before:
-- the first attempt at this proof reported "run_scheduled_ledger_checks wrote
-- 1 delivery row for the archived company" about a row written days earlier.
--
-- BEHAVIOURAL: a real company is archived inside a subtransaction, with a
-- planted fixed expense and a planted auto-invoice client, and all three jobs
-- are run. Each must process the OTHER company and skip the archived one — the
-- two-directional form, because "it wrote nothing for the archived company"
-- is also true of a job that did nothing at all. The company is then
-- un-archived and the jobs re-run, which must now pick it up. The whole thing
-- unwinds through a deliberate raise (0321).
--
-- The fixtures are planted BEFORE the company is archived, because 0329 would
-- refuse the inserts afterwards — which is the same trap 0330's proof hit.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_arch    uuid;
  v_other   uuid;
  v_src     text;
  v_hits    int;
  v_fe      uuid;
  v_cl      uuid;
  v_month   date := date_trunc('month', current_date)::date;
  v_outcome text;
  v_mode    text;
  v_r       record;
  -- what the archived company got, and what the other one got
  a_checks int; o_checks int; a_fx int; o_fx int; a_inv int; o_inv int;
  b_checks int; b_fx int; b_inv int;
  -- Baselines. These must be DELTAS, not totals: a database that has run these
  -- jobs before already holds rows for both companies, and a total would report
  -- "the archived company was written to" about work done last week.
  z_a_checks int; z_o_checks int; z_a_fx int; z_o_fx int; z_o_inv int;
begin
  ---------------------------------------------------------------------------
  -- STATIC
  ---------------------------------------------------------------------------
  for v_r in
    select * from (values
      ('run_scheduled_ledger_checks',      'notification_deliveries'),
      ('generate_fixed_expense_instances', 'fixed_expense_instances'),
      ('run_auto_invoices',                'next_invoice_number')
    ) as t(fn, marker)
  loop
    select pg_get_functiondef(p.oid) into v_src
      from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = v_r.fn;

    v_hits := (select count(*) from regexp_matches(v_src, 'archived_at', 'g'));
    if v_hits <> 1 then
      raise exception '0331 FAILED: % reads archived_at % times, expected exactly 1', v_r.fn, v_hits;
    end if;
    if position(v_r.marker in v_src) = 0 then
      raise exception
        '0331 FAILED: % no longer contains %, so the surgery replaced more than its anchor', v_r.fn, v_r.marker;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- BEHAVIOURAL
  ---------------------------------------------------------------------------
  -- Both must be ACTIVE as well as un-archived: run_scheduled_ledger_checks
  -- loops `where c.active`, so an inactive comparison company would be skipped
  -- for a reason having nothing to do with this migration.
  select id into v_arch  from public.companies where archived_at is null and active order by name desc limit 1;
  select id into v_other from public.companies where archived_at is null and active and id <> v_arch order by name limit 1;

  if v_arch is null or v_other is null then
    v_mode := 'STATIC ONLY — fewer than two active un-archived companies, so "skips one and not the other" cannot be shown';
  else
    v_mode := 'STATIC AND BEHAVIOURAL';
    begin
      -- Fixtures, planted while both companies are still un-archived.
      insert into public.fixed_expenses (company_id, amount, payment_mode, start_month, description)
      values (v_arch, 100, 'Cash', v_month, '0331 proof fixture') returning id into v_fe;
      insert into public.fixed_expenses (company_id, amount, payment_mode, start_month, description)
      values (v_other, 100, 'Cash', v_month, '0331 proof fixture');

      insert into public.clients (company_id, name, auto_invoice_enabled, auto_invoice_amount, advance_payment)
      values (v_arch, '0331 proof fixture', true, 1000, true) returning id into v_cl;
      insert into public.clients (company_id, name, auto_invoice_enabled, auto_invoice_amount, advance_payment)
      values (v_other, '0331 proof fixture', true, 1000, true);

      select count(*) into z_a_checks from public.notification_deliveries
       where company_id = v_arch and subject = 'Scheduled ledger_checks';
      select count(*) into z_o_checks from public.notification_deliveries
       where company_id = v_other and subject = 'Scheduled ledger_checks';
      select count(*) into z_a_fx from public.fixed_expense_instances where company_id = v_arch;
      select count(*) into z_o_fx from public.fixed_expense_instances where company_id = v_other;
      select count(*) into z_o_inv from public.invoices
       where company_id = v_other and notes like 'Auto-issued%';

      update public.companies set archived_at = now() where id = v_arch;

      -- All three jobs run. None may raise.
      perform public.run_scheduled_ledger_checks();
      perform public.generate_fixed_expense_instances(current_date);
      perform public.run_auto_invoices(current_date);

      select count(*) - z_a_checks into a_checks from public.notification_deliveries
       where company_id = v_arch and subject = 'Scheduled ledger_checks';
      select count(*) - z_o_checks into o_checks from public.notification_deliveries
       where company_id = v_other and subject = 'Scheduled ledger_checks';
      select count(*) - z_a_fx into a_fx from public.fixed_expense_instances where company_id = v_arch;
      select count(*) - z_o_fx into o_fx from public.fixed_expense_instances where company_id = v_other;
      select count(*) into a_inv from public.invoices where client_id = v_cl;
      select count(*) - z_o_inv into o_inv from public.invoices
       where company_id = v_other and notes like 'Auto-issued%';

      if a_checks <> 0 then raise exception '0331 FAILED: run_scheduled_ledger_checks wrote % delivery row(s) for the archived company', a_checks; end if;
      if a_fx     <> 0 then raise exception '0331 FAILED: generate_fixed_expense_instances raised % instance(s) for the archived company', a_fx; end if;
      if a_inv    <> 0 then raise exception '0331 FAILED: run_auto_invoices issued % invoice(s) for the archived company', a_inv; end if;

      -- The other direction. Without these three, a job that did nothing at all
      -- would pass every assertion above.
      if o_checks  = 0 then raise exception '0331 FAILED: run_scheduled_ledger_checks skipped the UN-archived company too'; end if;
      if o_fx      = 0 then raise exception '0331 FAILED: generate_fixed_expense_instances skipped the UN-archived company too'; end if;
      if o_inv     = 0 then raise exception '0331 FAILED: run_auto_invoices skipped the UN-archived company too'; end if;

      -- And it is a filter, not a removal: un-archive and the company returns.
      update public.companies set archived_at = null where id = v_arch;
      perform public.run_scheduled_ledger_checks();
      perform public.generate_fixed_expense_instances(current_date);
      perform public.run_auto_invoices(current_date);

      select count(*) - z_a_checks into b_checks from public.notification_deliveries
       where company_id = v_arch and subject = 'Scheduled ledger_checks';
      select count(*) - z_a_fx into b_fx from public.fixed_expense_instances where company_id = v_arch;
      select count(*) into b_inv from public.invoices where client_id = v_cl;

      if b_checks = 0 or b_fx = 0 or b_inv = 0 then
        raise exception
          '0331 FAILED: after un-archiving, the company is still skipped (checks %, fixed expenses %, invoices %) — the filter is behaving as a removal',
          b_checks, b_fx, b_inv;
      end if;

      raise exception 'PROBE_ROLLBACK';
    exception when others then
      v_outcome := sqlerrm;
    end;

    if v_outcome <> 'PROBE_ROLLBACK' then
      raise exception '0331 FAILED (behavioural probe): %', v_outcome;
    end if;

    if exists (select 1 from public.fixed_expenses where description = '0331 proof fixture')
       or exists (select 1 from public.clients where name = '0331 proof fixture')
       or exists (select 1 from public.companies where archived_at is not null and id = v_arch)
    then
      raise exception '0331 FAILED: the probe did not unwind — a fixture or an archive stamp survived';
    end if;
  end if;

  raise notice
    '0331 OK (%): all three jobs read archived_at exactly once and kept their own bodies. Archived company got [checks %, fixed expenses %, invoices %]; the un-archived one got [%, %, %]; after un-archiving the first got [%, %, %].',
    v_mode, a_checks, a_fx, a_inv, o_checks, o_fx, o_inv, b_checks, b_fx, b_inv;
end
$proof$;
