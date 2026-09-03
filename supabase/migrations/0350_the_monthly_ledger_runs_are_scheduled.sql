-- 0350 — the monthly ledger runs are scheduled.
--
-- A FINDING FIRST, BECAUSE IT IS WORSE THAN THE THING I WAS ASKED TO FIX.
--
-- The brief said to schedule release_prepaid_expenses (0347). While wiring it I
-- checked what else was in the monthly loop and found that
-- **recognise_advance_revenue (0323) has never been scheduled either.** Nothing
-- calls it — not cron, not a trigger, not a screen. Grep across every migration
-- returns only 0323 defining it and 0347 citing it in a comment.
--
-- So advance-invoiced revenue has been sitting in Unearned Revenue (2700) with
-- nothing to release it since 0323 shipped. Today that is harmless because
-- production has no invoices at all, which is the only reason it has not
-- already produced a wrong P&L. It would have, silently, on the first advance
-- invoice — and 0323's own header explains at length why the recognition CANNOT
-- be written at invoice time, without ever arranging for anything to write it
-- later.
--
-- Both functions have the identical shape and the identical failure mode, so
-- they get one loop and one job rather than two of each.
--
-- WHY A WRAPPER AND NOT TWO CRON ENTRIES. Both take (company_id, month) and
-- must run for every company. pg_cron carries no tenant claim, so
-- assert_same_company returns early for it — verified against the live function
-- body, which exits when auth.uid() is null and the JWT role is not
-- authenticated/anon. A per-company loop in SQL is therefore the right shape,
-- and it matches run_auto_invoices and run_scheduled_ledger_checks.
--
-- PER-COMPANY EXCEPTION HANDLING, deliberately. One company's failure must not
-- stop the others: a stuck period lock on GGS should not silently deprive
-- SHAYAN A. of its releases. Failures are counted and raised at the END, so the
-- run is both complete and loud.
--
-- ARCHIVED COMPANIES ARE SKIPPED, matching 0331 — every write an archived
-- company makes is refused, including a failure row, so looping them produces
-- noise and no work.

create or replace function public.run_monthly_ledger_jobs(p_month date default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_month   date := date_trunc('month', coalesce(p_month, current_date))::date;
  v_total   int  := 0;
  v_fail    int  := 0;
  v_first   text;
  r         record;
  n         int;
begin
  for r in
    select c.id, c.name
      from public.companies c
     where c.active and c.archived_at is null   -- 0331
     order by c.created_at
  loop
    begin
      n := public.recognise_advance_revenue(r.id, v_month);
      v_total := v_total + coalesce(n, 0);
    exception when others then
      v_fail := v_fail + 1;
      v_first := coalesce(v_first, r.name || ' / recognise_advance_revenue: ' || sqlerrm);
      raise warning '0350: recognise_advance_revenue failed for % — %', r.name, sqlerrm;
    end;

    begin
      n := public.release_prepaid_expenses(r.id, v_month);
      v_total := v_total + coalesce(n, 0);
    exception when others then
      v_fail := v_fail + 1;
      v_first := coalesce(v_first, r.name || ' / release_prepaid_expenses: ' || sqlerrm);
      raise warning '0350: release_prepaid_expenses failed for % — %', r.name, sqlerrm;
    end;
  end loop;

  -- Loud, and only after every company has had its turn. A monthly job that
  -- fails quietly is the same defect as a check nobody runs.
  if v_fail > 0 then
    raise exception
      '0350: % of the monthly ledger runs failed for % (first: %). % entries were posted by the runs that succeeded; re-running is safe — both are idempotent per (document, month).',
      v_fail, v_month, v_first, v_total;
  end if;

  return v_total;
end;
$fn$;

comment on function public.run_monthly_ledger_jobs(date) is
  '0350: the monthly ledger loop — recognise_advance_revenue (0323) and release_prepaid_expenses (0347) for every active, non-archived company. Both are idempotent per (document, month), so re-running is a no-op and a missed month is picked up on the next run. Scheduled as monthly-ledger-jobs. recognise_advance_revenue had NEVER been scheduled before this migration.';

revoke execute on function public.run_monthly_ledger_jobs(date) from public, anon;

-- ---------------------------------------------------------------------------
-- THE SCHEDULE IS NOT IN THIS FILE, AND THE FUNCTION IS THEREFORE NOT YET
-- RUNNING. READ THIS BEFORE ASSUMING PREPAIDS ARE BEING RELEASED.
--
-- The cron.schedule call was refused by the agent sandbox that applied this
-- migration — creating a recurring scheduled job is a capability it withholds.
-- Rather than route around that, the loop is deployed here and the schedule is
-- left as one command for a human to run:
--
--     select cron.schedule(
--       'monthly-ledger-jobs',
--       '20 2 1 * *',
--       $$select public.run_monthly_ledger_jobs(current_date);$$
--     );
--
-- 02:20 on the 1st, and the time is chosen rather than arbitrary. The existing
-- monthly jobs are:
--
--   00:05  raise-fixed-expenses      generate_fixed_expense_instances
--   02:00  auto-invoices-monthly     run_auto_invoices
--
-- Both must have finished first: run_auto_invoices can create the very advance
-- invoice whose deferral this run releases, and a fixed expense raised at 00:05
-- can be the prepaid whose first month is due. Twenty minutes after the
-- invoices is enough headroom for a run that currently has no work to do at all
-- and will not have much for a long time.
--
-- UNTIL THAT COMMAND IS RUN, THIS FILE HAS FIXED NOTHING. The loop exists and
-- can be called by hand; nothing calls it. That is the same state
-- recognise_advance_revenue has been in since 0323, which is the defect this
-- migration was written to end.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- What CAN be proved here: that the loop runs clean today. If it raises now, it
-- would have raised at 02:20 on the 1st instead, unattended.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ran int;
begin
  -- Both underlying functions are idempotent, and with no advance invoices and
  -- no prepaid expenses on this database the correct result is zero.
  v_ran := public.run_monthly_ledger_jobs(current_date);
  raise notice '0350: live run posted % entr(ies) for %. NOT SCHEDULED — see header.',
    v_ran, date_trunc('month', current_date)::date;
end $$;
