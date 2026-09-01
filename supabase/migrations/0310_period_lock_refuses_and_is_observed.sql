-- 0310 — the period lock must not fail open, and the refusal must be observable.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- WHAT WAS WRONG
--
-- Both period-lock triggers began:
--
--   if public.current_company_id() is null and not public.is_ssa_unscoped() then
--     return coalesce(new, old);
--   end if;
--
-- No tenant identity meant the lock did not run at all. Demonstrated on dev
-- and rolled back: with July 2026 closed and is_period_closed() returning TRUE
-- in the same statement, a session with no JWT inserted an expense dated
-- 2026-07-15 into the closed month. No refusal, and nothing recorded that it
-- had happened.
--
-- That is every backend context — service_role, pg_cron, psql, migrations and
-- the Edge Functions.
--
-- WHY THIS IS NOT THE SAME CALL AS assert_same_company's EARLY RETURN
--
-- assert_same_company returns early for a caller with no tenant, and that is
-- correct: it is a guard about WHOSE data this is, and a trusted backend
-- legitimately has no tenant. A period lock is a different assertion. Closing
-- a month says these figures are final, and finality that depends on who holds
-- the pen is not finality.
--
-- THE FIX: FALL THROUGH, DO NOT RETURN
--
-- The early return is replaced by a maintenance-session bypass, and everything
-- else falls through to the check that was already there. That check reads the
-- company off the ROW (`($1).company_id`), never off the session, so it works
-- perfectly well without a tenant identity — the early return was never needed
-- for it to function.
--
-- The consequence is precise and small: a backend caller writing into an OPEN
-- month is unaffected; a backend caller writing into a CLOSED month is now
-- refused, exactly as a user would be.
--
-- THE ALLOW-LIST IS ONE ENTRY LONG
--
-- is_maintenance_session() — `app.ledger_maintenance = 'on'` AND session_user
-- is superuser or bypassrls. It is already role-gated, already the sanctioned
-- way to write a closed period, and it deliberately reads session_user rather
-- than current_user so a SECURITY DEFINER function cannot launder into it.
--
-- Nothing else is named. Anything that later needs to post into a closed month
-- gets added here with a written reason, or it does not get to.
--
-- WHAT THIS BREAKS, MEASURED RATHER THAN GUESSED
--
-- Every backend writer was enumerated by listing what each cron job actually
-- inserts into, rather than by reading its name:
--
--   run_auto_invoices              -> invoices          PERIOD-LOCKED
--   generate_fixed_expense_instances -> fixed_expense_instances   not locked
--   enforce_subscription_expiry    -> nothing           not locked
--   run_scheduled_ledger_checks    -> notification_deliveries     not locked
--   invoke_send_compliance_alerts  -> nothing (HTTP)    not locked
--
-- **run_auto_invoices is the only scheduled job that writes a period-locked
-- table.** It runs at 02:00 on the 1st and dates its invoices `current_date`,
-- so it writes into the month that has just opened. It is only affected if
-- someone has closed the current month, in which case refusing is right.
--
-- (generate_fixed_expense_instances writes fixed_expense_instances, not
-- expenses. I assumed otherwise from its name and checked; the assumption was
-- wrong. That is the whole method of this file.)
--
-- The migrations that repost — 0249, 0250, 0258, 0265, 0281, 0282, 0284, 0287 —
-- have relied on the exemption. They are inert against today's data because
-- accounting_periods is EMPTY on both databases: no month is closed, so nothing
-- is refused. On a replay against a database with closed months they would need
-- the maintenance session, which 0224, 0225, 0245 and 0247 already set.
--
-- AND THE IRONY, FOR THE RECORD
--
-- 0301 scheduled run_scheduled_ledger_checks as a pg_cron job, which runs with
-- no tenant identity. The mechanism watching the ledger was itself exempt from
-- the lock protecting it. It writes nothing period-locked, so nothing was
-- actually wrong — but the exemption covered it, and it covered it silently.
--
-- THE DETECTION HALF, WHICH STAYS EVEN NOW THE REFUSAL EXISTS
--
-- A refusal you cannot observe is a refusal you are trusting.
-- closed_period_intrusions() asks the question directly: is there a row DATED
-- inside a closed period that was CREATED after that period was closed?
--
-- One detail that cost a verification run, and is worth the sentence: the
-- comparison is strict (`created_at > closed_at`). In reality a close and a
-- write are separate transactions, so their stamps differ. Inside a single
-- transaction they do not — now() is transaction-start — and the first run of
-- the verification below failed because the probe row and the period close
-- shared a timestamp to the microsecond. 9.12's clock lesson, arriving for a
-- third time, inside the detector written to apply it. The fix was in the test.
--
-- It is self-clearing by design. A sanctioned maintenance write into a closed
-- month leaves a finding until the month is reopened and re-closed, which moves
-- closed_at past the row. That is the correct workflow anyway — a month you
-- have written into is a month whose close should be renewed — so the check
-- does not become a permanent red on legitimate activity (9.11).

-- ---------------------------------------------------------------------------
-- 1. The two triggers stop failing open.
-- ---------------------------------------------------------------------------

do $patch$
declare
  r record; v_def text; v_new text; v_old text; v_rep text;
begin
  for r in
    select * from (values
      ('enforce_period_lock',
       E'  if public.current_company_id() is null and not public.is_ssa_unscoped() then\n    return coalesce(new, old);\n  end if;',
       E'  -- 0310. NOT an early return for a caller with no tenant. The check\n  -- below reads the company off the ROW, so it needs no session identity.\n  -- The only bypass is a maintenance session: app.ledger_maintenance = ''on''\n  -- AND session_user superuser/bypassrls.\n  if public.is_maintenance_session() then\n    return coalesce(new, old);\n  end if;'),
      ('enforce_period_lock_journal_lines',
       E'  if public.current_company_id() is null and not public.is_ssa_unscoped() then\n    return v_ret;\n  end if;',
       E'  -- 0310. See enforce_period_lock. Same change, same reason.\n  if public.is_maintenance_session() then\n    return v_ret;\n  end if;')
    ) as t(fname, oldtxt, newtxt)
  loop
    v_old := r.oldtxt; v_rep := r.newtxt;

    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = r.fname;

    if v_def ~ 'is_maintenance_session' then
      raise notice '0310: % already patched', r.fname;
      continue;
    end if;

    -- The bodies are stored with CRLF on this database, so match on a
    -- line-ending-insensitive form rather than assuming either.
    if strpos(replace(v_def, chr(13), ''), v_old) = 0 then
      raise exception '0310 FAILED: the fail-open branch was not found verbatim in % — do not guess', r.fname;
    end if;

    v_new := replace(replace(v_def, chr(13), ''), v_old, v_rep);
    if v_new = replace(v_def, chr(13), '') then
      raise exception '0310 FAILED: substitution changed nothing in %', r.fname;
    end if;
    execute v_new;
  end loop;
end
$patch$;

-- ---------------------------------------------------------------------------
-- 2. The detector.
-- ---------------------------------------------------------------------------

create or replace function public.closed_period_intrusions(p_company_id uuid)
returns table (source_table text, row_id uuid, dated date, created timestamptz, closed_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  with closed as (
    select ap.company_id, ap.period_month, ap.closed_at
      from public.accounting_periods ap
     where ap.company_id = p_company_id and ap.closed_at is not null
  ),
  rows_dated as (
    select 'expenses'::text        t, e.id, e.expense_date d, e.created_at c, e.company_id co from public.expenses e
    union all
    select 'invoices',             i.id, i.invoice_date,  i.created_at, i.company_id from public.invoices i
    union all
    select 'advances',             a.id, a.advance_date,  a.created_at, a.company_id from public.advances a
    union all
    select 'cheques',              q.id, q.cheque_date,   q.created_at, q.company_id from public.cheques q
    union all
    select 'invoice_payments',     p.id, p.payment_date,  p.created_at, p.company_id from public.invoice_payments p
    union all
    select 'payslips',             s.id, s.period_month,  s.created_at, s.company_id from public.payslips s
    union all
    select 'journal_entries',      j.id, j.entry_date,    j.created_at, j.company_id from public.journal_entries j
  )
  select r.t, r.id, r.d, r.c, cl.closed_at
    from rows_dated r
    join closed cl
      on cl.company_id = r.co
     and r.d >= cl.period_month
     and r.d <  (cl.period_month + interval '1 month')::date
   where r.c > cl.closed_at
   order by r.c desc;
end
$$;

comment on function public.closed_period_intrusions(uuid) is
  'Rows DATED inside a closed period that were CREATED after that period was closed. The observation half of the period lock (0310) — a refusal you cannot observe is a refusal you are trusting. Self-clearing: reopening and re-closing the month moves closed_at past the row, which is the workflow a sanctioned maintenance write should follow anyway.';

-- ---------------------------------------------------------------------------
-- 3. Wire it, and bump the canary once.
-- ---------------------------------------------------------------------------

do $wire$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text; p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks';

  if v_src ~ 'no_posting_into_a_closed_period' then
    raise notice '0310: already wired';
    return;
  end if;

  if strpos(v_src, E'  )\n  select * from real_checks') = 0 then
    raise exception '0310 FAILED: could not find the close of the real_checks CTE';
  end if;

  v_new := replace(v_src, E'  )\n  select * from real_checks',
       E'    union all\n'
    || E'    -- 0310. Did anything land in a month that was already closed?\n'
    || E'    -- Quiet on every company today because accounting_periods is empty;\n'
    || E'    -- able to speak the moment a month is closed and something writes\n'
    || E'    -- into it anyway.\n'
    || E'    select ''no_posting_into_a_closed_period''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.closed_period_intrusions(p_company_id)\n'
    || E'  )\n  select * from real_checks');

  if strpos(v_new, 'select 25::numeric n) e (n)') = 0 then
    raise exception '0310 FAILED: the canary is not 25 — do not adjust it blindly';
  end if;
  v_new := replace(v_new, 'select 25::numeric n) e (n)', 'select 26::numeric n) e (n)');

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);
  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$wire$;

-- ---------------------------------------------------------------------------
-- 4. Verification.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_br uuid; v_month date := date '2026-07-01';
      v_bad int; v_rows int; v_state text; v_msg text; v_id uuid;
    begin
      select id into v_co from public.companies where name = 'SANDBOX TESTING ORG';
      if v_co is null then
        select id into v_co from public.companies order by created_at limit 1;
      end if;
      select branch_id into v_br from public.employees
       where company_id = v_co and branch_id is not null limit 1;

      -- This block has no JWT, exactly like pg_cron and the Edge Functions.
      if public.current_company_id() is not null then
        raise exception '0310 FAILED: running with a tenant identity, so it cannot prove the backend case';
      end if;

      -- Closed an hour ago, not "now". Everything in one transaction shares
      -- now(), so a period closed at now() and a row created at now() carry
      -- IDENTICAL stamps and `created > closed_at` is false. The first run of
      -- this verification failed on exactly that, which is 9.12's clock lesson
      -- arriving a third time — in the detector I wrote to apply it.
      --
      -- The detector is right to use strict `>`: in reality a close and a write
      -- are separate transactions microseconds apart at worst. It is the TEST
      -- that has to stop pretending they are simultaneous.
      insert into public.accounting_periods (company_id, period_month, closed_at)
      values (v_co, v_month, now() - interval '1 hour');

      -- 1. THE WRITE THAT SUCCEEDED BEFORE THIS MIGRATION IS NOW REFUSED.
      -- Measured on dev before 0310: this insert succeeded silently.
      v_state := null;
      begin
        insert into public.expenses (company_id, branch_id, amount, expense_date,
                                     description, payment_mode)
        values (v_co, v_br, 10, v_month, 'ZZ 0310 no-tenant probe', 'Bank');
        raise exception '0310 FAILED: a no-tenant caller still wrote into a closed month';
      exception
        when others then
          get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
          if v_msg like '0310 FAILED%' then raise; end if;
          if v_msg not like 'Period for%' then
            raise exception '0310 FAILED: refused, but not by the period lock (% %)', v_state, left(v_msg, 80);
          end if;
      end;

      -- 2. AN OPEN MONTH IS STILL WRITABLE BY THE SAME CALLER. Without this
      -- the fix would read as "backend writes are refused", which would break
      -- run_auto_invoices on the 1st of every month.
      insert into public.expenses (company_id, branch_id, amount, expense_date,
                                   description, payment_mode)
      values (v_co, v_br, 10, (v_month + interval '2 months')::date,
              'ZZ 0310 open-month probe', 'Bank');

      -- 3. THE ALLOW-LIST WORKS, AND IS THE ONLY WAY IN. A maintenance session
      -- may write the closed month.
      perform set_config('app.ledger_maintenance', 'on', true);
      if not public.is_maintenance_session() then
        raise exception '0310 FAILED: this session cannot become a maintenance session, so the allow-list is untestable here';
      end if;
      insert into public.expenses (company_id, branch_id, amount, expense_date,
                                   description, payment_mode)
      values (v_co, v_br, 10, v_month, 'ZZ 0310 maintenance probe', 'Bank')
      returning id into v_id;
      perform set_config('app.ledger_maintenance', 'off', true);

      -- 4. AND THE DETECTOR SEES IT. This is the point of the detection half:
      -- the sanctioned write is allowed AND visible.
      select count(*) into v_bad from public.closed_period_intrusions(v_co)
       where row_id = v_id;
      if v_bad <> 1 then
        raise exception '0310 FAILED: the detector did not report a maintenance write into a closed month (% rows)', v_bad;
      end if;

      -- 5. AND THE CHECK GOES RED FOR IT.
      select count(*) into v_bad from public.ledger_checks(v_co) l
       where l.check_name = 'no_posting_into_a_closed_period' and not l.passed;
      if v_bad <> 1 then
        raise exception '0310 FAILED: the check stayed green with an intrusion present';
      end if;

      -- 6. SELF-CLEARING. Re-closing the month moves closed_at past the row,
      -- which is the workflow a deliberate write should follow.
      -- clock_timestamp(), not now(): the re-close must be strictly LATER than
      -- the row it is meant to absorb, and inside this transaction now() is
      -- earlier than the row's own created_at default.
      update public.accounting_periods set closed_at = clock_timestamp()
       where company_id = v_co and period_month = v_month;
      if exists (select 1 from public.closed_period_intrusions(v_co) where row_id = v_id) then
        raise exception '0310 FAILED: re-closing the month did not clear the finding';
      end if;

      -- 7. THE SUITE GREW BY ONE AND THE CANARY PASSES — the verdict, not the
      -- operands (0300's omission, 0302's lesson).
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 27 then
        raise exception '0310 FAILED: ledger_checks returned % rows, expected 27 (26 checks + canary)', v_rows;
      end if;
      select count(*) into v_bad
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_bad <> 0 then
        raise exception '0310 FAILED: the canary is red on % compan(ies)', v_bad;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0310 verification failed: %', v_outcome;
  end if;
end
$verify$;
