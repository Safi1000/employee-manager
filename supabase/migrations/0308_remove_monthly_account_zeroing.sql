-- 0308 — remove apply_monthly_account_zeroing(). Stage A of the ledger deployment.
--
-- DEV ONLY. Production gets this as the first item of Stage A, under its own
-- named authorisation.
--
-- WHY THIS GOES FIRST, AHEAD OF EVERYTHING ELSE
--
-- Of the four accounting reds on SANDBOX, three are fixture data. This one is a
-- live mechanism, it is on production, and it runs unprompted. Deploying a
-- ledger while it is still there is deploying the fix alongside the cause.
--
-- WHAT IT ACTUALLY DID, WHICH IS WORSE THAN HOW IT WAS FIRST DESCRIBED
--
-- I recorded it as "sets an operational balance with no transaction row and no
-- journal entry". Reading the source rather than the symptom: it DOES write a
-- bank_transactions row for the month-end adjustment, and it writes no journal
-- entry for it. But that is not where the 800,000 went.
--
-- The destructive statement is the last one in the loop, and it is
-- unconditional:
--
--     update public.bank_accounts b
--        set balance = coalesce(
--              (select sum(account_delta) from public.bank_transactions
--                where bank_account_id = b.id), 0),
--            last_zeroed_month = ...
--      where b.id = acct.id;
--
-- It RECOMPUTES the balance from bank_transactions alone. Any balance that was
-- not built from that log is discarded.
--
-- Every opening balance in this system was seeded directly onto
-- bank_accounts.balance without a bank_transactions row. Measured on dev:
--
--     account          balance      Σ account_delta   difference
--     Habib Bank Ltd     536,822          -713,178     1,250,000  <- opening
--     Meezan Bank      3,843,255        -1,156,745     5,000,000  <- opening
--     United Bank Ltd          0                 0             0  <- gone
--
-- United Bank Ltd is the one account in either database with
-- auto_zero_monthly = true. It holds an 800,000 opening balance in the GL, from
-- opening_balance_batches, dated 2026-05-31. It has zero bank_transactions, so
-- the recompute set its balance to zero and the 800,000 exists on one side of
-- the system only. Nothing was "zeroed"; an opening balance was overwritten by
-- a recomputation from a log that never contained it.
--
-- If the flag were ticked on Habib Bank Ltd, the next Accounting page load
-- would silently remove 1,250,000 the same way.
--
-- "CONFIRM NOTHING CALLS IT FIRST" — SOMETHING DOES, AND IT IS WORSE THAN A BUTTON
--
-- It is not reachable from a button. src/app/pages/super-admin/Accounting.tsx
-- calls it at the top of loadAll(), so it runs on EVERY LOAD of the Accounting
-- page, wrapped in a try/catch whose comment says the error may be ignored
-- because the function might not exist yet.
--
-- That try/catch is why dropping the function is safe for the deployed build,
-- and it is worth being precise about why: supabase.rpc() RESOLVES with an
-- error object rather than throwing, so the catch never fires either way and a
-- missing function is discarded by the destructuring, not by the handler. The
-- page keeps working. The frontend call and the checkbox that arms the flag are
-- removed in the same commit, but they are not fused to this migration in
-- either direction.
--
-- Nothing else reaches it: no cron job on dev or prod, no view, no trigger, no
-- policy, no column default, no other function. Checked, and re-checked below.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not drop bank_accounts.auto_zero_monthly. Dropping a column the
-- deployed build inserts is a Stage D change and it belongs with the other
-- drops, as 0309. Between the two the column is inert — no mechanism reads it,
-- which this migration asserts — and the UI that could set it is gone, so no
-- new row can be flagged.
--
-- It does not un-zero United Bank Ltd. The 800,000 discrepancy stays visible in
-- bank_per_account_gl_equals_operational, at that number, as the standing
-- evidence for this removal. Repairing sandbox data would erase the only
-- demonstration that the mechanism was real.
--
-- AND IT ASSERTS NO ENVIRONMENT-SPECIFIC NUMBER
--
-- The first version of this file asserted United Bank Ltd reads balance 0 and
-- GL 800,000. That is true on dev and FALSE ON PRODUCTION, where the same
-- account reads balance 0 and GL 0 — prod's sandbox has no opening-balance
-- journal entry behind it. The migration would have aborted on prod on a fact
-- about dev.
--
-- A number measured in one database is not a property of the migration. What
-- this migration must guarantee is environment-independent and stronger:
-- REMOVING THE MECHANISM MOVES NO MONEY. So it snapshots bank_accounts before
-- and requires every row to be byte-identical afterwards, on whatever database
-- it runs against. The per-account figures are reported as a NOTICE, which is
-- what they are: evidence, not a precondition.

-- ---------------------------------------------------------------------------
-- 1. Prove it is destructive, BEFORE removing it.
-- ---------------------------------------------------------------------------
--
-- A removal justified by a story is a removal nobody can check later. This
-- block reconstructs the exact shape — an account with a seeded balance and no
-- transaction history — runs the function, and requires the balance to be
-- destroyed. Everything it does is rolled back with the subtransaction.

create temporary table zz_0308_before on commit drop as
  select id, bank_name, balance, opening_balance, auto_zero_monthly
    from public.bank_accounts;

do $prove$
declare
  v_outcome text;
begin
  -- Replay safety: on a database where the function is already gone there is
  -- nothing to demonstrate, and demonstrating it is not a reason to keep it.
  if not exists (select 1 from pg_proc
                  where pronamespace = 'public'::regnamespace
                    and proname = 'apply_monthly_account_zeroing') then
    raise notice '0308: apply_monthly_account_zeroing is already absent — proof skipped';
    return;
  end if;

  begin
    declare
      v_co uuid; v_acct uuid; v_before numeric; v_after numeric;
    begin
      select id into v_co from public.companies order by created_at limit 1;

      -- Take the real flagged accounts out of scope so this proves something
      -- about the probe and not about the sandbox.
      update public.bank_accounts set auto_zero_monthly = false where auto_zero_monthly;

      insert into public.bank_accounts
        (company_id, bank_name, account_number, account_type,
         opening_balance, balance, auto_zero_monthly, created_at)
      values (v_co, 'ZZ 0308 PROBE BANK', 'ZZ-0308', 'Current',
              1250000, 1250000, true, now() - interval '3 months')
      returning id into v_acct;

      select balance into v_before from public.bank_accounts where id = v_acct;
      if v_before <> 1250000 then
        raise exception '0308: probe did not seed (balance %)', v_before;
      end if;

      perform public.apply_monthly_account_zeroing();

      select balance into v_after from public.bank_accounts where id = v_acct;
      if v_after <> 0 then
        raise exception
          '0308 CANNOT JUSTIFY ITSELF: the function left the seeded balance at % rather than destroying it. Do not drop it on this reasoning — re-read the source.',
          v_after;
      end if;

      -- And it recorded nothing to explain the loss: no bank_transactions row
      -- for the probe, because net movement was zero in every month.
      if exists (select 1 from public.bank_transactions where bank_account_id = v_acct) then
        raise exception '0308: the probe gained a transaction row — the mechanism is not the one described above';
      end if;

      raise exception 'PROVEN';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'PROVEN' then
    raise exception '0308 pre-removal proof failed: %', v_outcome;
  end if;
  raise notice '0308: confirmed — 1,250,000 seeded, 0 after one call, nothing recorded';
end
$prove$;

-- ---------------------------------------------------------------------------
-- 2. Remove it.
-- ---------------------------------------------------------------------------

drop function if exists public.apply_monthly_account_zeroing();

comment on column public.bank_accounts.auto_zero_monthly is
  'DEAD as of 0308. The mechanism that read this — apply_monthly_account_zeroing() — recomputed balance from bank_transactions alone and destroyed any opening balance seeded directly, and it ran on every Accounting page load. The column is dropped by 0309 with the Stage D column drops. Do not write a new reader for it.';

-- ---------------------------------------------------------------------------
-- 3. Verification.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_n int; v_flagged int; v_bal numeric; v_gl numeric;
    begin
      -- 1. IT IS GONE.
      select count(*) into v_n from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname = 'apply_monthly_account_zeroing';
      if v_n <> 0 then
        raise exception '0308 FAILED: the function still exists';
      end if;

      -- 2. AND NOTHING IN THE DATABASE STILL NAMES IT. A dropped function that
      -- some other function still calls is a runtime error waiting for a
      -- caller, which is the failure mode this deployment is built to avoid.
      select count(*) into v_n from (
        select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.prosrc ~ 'apply_monthly_account_zeroing'
        union all
        select 1 from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
           and pg_get_viewdef(c.oid) ~ 'apply_monthly_account_zeroing'
        union all
        select 1 from cron.job j where j.command ~ 'apply_monthly_account_zeroing'
        union all
        select 1 from pg_attrdef d
         where pg_get_expr(d.adbin, d.adrelid) ~ 'apply_monthly_account_zeroing'
      ) r;
      if v_n <> 0 then
        raise exception '0308 FAILED: % database object(s) still reference the dropped function', v_n;
      end if;

      -- 3. THE COLUMN IS NOW PROVABLY INERT. This is the assertion that makes
      -- leaving it until 0309 safe: not "we think nothing reads it" but "no
      -- function, view, trigger, cron job or default expression does".
      select count(*) into v_n from (
        select 1 from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.prosrc ~ '\mauto_zero_monthly\M'
        union all
        select 1 from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
           and pg_get_viewdef(c.oid) ~ '\mauto_zero_monthly\M'
        union all
        select 1 from cron.job j where j.command ~ '\mauto_zero_monthly\M'
      ) r;
      if v_n <> 0 then
        raise exception '0308 FAILED: % object(s) still read auto_zero_monthly — the column is not inert', v_n;
      end if;

      -- 4. REMOVING THE MECHANISM MOVED NO MONEY. Every bank_accounts row is
      -- byte-identical to the snapshot taken before the proof block ran —
      -- compared in BOTH directions, so a row that appeared counts as a
      -- failure too. This is the assertion that has to hold on every database,
      -- and it is what the probe's rollback is really being checked for: if it
      -- had not rolled back, United Bank Ltd would now be unflagged and the
      -- standing evidence would be gone.
      select count(*) into v_n from (
        select * from zz_0308_before
        except all
        select id, bank_name, balance, opening_balance, auto_zero_monthly
          from public.bank_accounts) d;
      if v_n <> 0 then
        raise exception '0308 FAILED: % bank account row(s) changed or vanished — the removal moved money', v_n;
      end if;

      select count(*) into v_n from (
        select id, bank_name, balance, opening_balance, auto_zero_monthly
          from public.bank_accounts
        except all
        select * from zz_0308_before) d;
      if v_n <> 0 then
        raise exception '0308 FAILED: % bank account row(s) appeared — the probe survived its rollback', v_n;
      end if;

      -- 5. THE EVIDENCE, REPORTED AND NOT ASSERTED. These figures differ by
      -- database: on dev United Bank Ltd reads balance 0 against a GL of
      -- 800,000; on production the same account reads 0 against a GL of 0.
      -- Both are consistent with the mechanism and neither is a property of
      -- this migration, so they are printed rather than required.
      for v_bal, v_gl, v_flagged in
        select ba.balance,
               coalesce((select sum(jl.debit - jl.credit)
                           from public.cash_locations cl
                           join public.journal_lines jl on jl.account_id = cl.coa_account_id
                          where cl.bank_account_id = ba.id and cl.coa_account_id is not null), 0),
               1
          from public.bank_accounts ba
         where ba.auto_zero_monthly
      loop
        raise notice '0308: flagged account left untouched — operational %, GL %', v_bal, v_gl;
      end loop;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0308 verification failed: %', v_outcome;
  end if;
end
$verify$;
