-- 0311 — drop the two columns 0308's mechanism read. Last block.
--
-- DEV ONLY. Production gets this at the end of the deployment.
--
-- RENUMBERED FROM 0309 ON 2026-09-01, AND WHY
--
-- A migration named 0309_confirm_backdate_override_bypass reached production
-- from another branch on 2026-09-01 at 09:14, fifty-six minutes after 0308 was
-- applied. It is a real and deliberate change — a supervisor override clears
-- the attendance backdate lock — and it owns the number 0309 on production.
--
-- Two migrations with the same number on one database is a naming failure that
-- costs someone an hour later, so this file moved rather than the one already
-- recorded on prod. 0310 was taken, so this is 0311.
--
-- 0308's comment and header still say "the column is dropped by 0309". That is
-- now stale. 0308 IS ALREADY APPLIED TO PRODUCTION, and rewriting the recorded
-- SQL of a production migration to correct a cross-reference is a bigger risk
-- than the stale reference itself — so the reference stands, and this paragraph
-- is the thing that explains it to whoever follows it and finds nothing.
--
-- 0308 dropped apply_monthly_account_zeroing() and left
-- bank_accounts.auto_zero_monthly and .last_zeroed_month in place, because
-- dropping a column the deployed build inserts is a coordinated release and
-- 0308 had to be safe to apply on its own.
--
-- The frontend commit that accompanies 0308 removed every read and write of
-- both columns — the checkbox, the insert, the two form resets and the type
-- field. So by the time this runs they are untouched by anything: no function,
-- no view, no trigger, no cron job, no default expression, no application code.
-- Asserted below rather than assumed.
--
-- WHY THEY GO AT ALL
--
-- A flag with no mechanism is worse than either. `auto_zero_monthly` reads as a
-- setting a user could rely on, and `last_zeroed_month` reads as a record of
-- something that happened. Left in place they invite exactly one thing: someone
-- writing a new reader for them, which is how the original arrived. The column
-- comment 0308 left says "do not write a new reader for it", and a comment is a
-- weaker instrument than the column not existing.
--
-- WHAT IS LOST
--
-- One boolean on one row — the sandbox's United Bank Ltd — and a null
-- last_zeroed_month everywhere. The 800,000 discrepancy this flag produced is
-- NOT repaired here and stays visible in
-- bank_per_account_gl_equals_operational. Dropping the flag removes the
-- mechanism's switch; the evidence of what it did stays.
--
-- AND IT ASSERTS NO ENVIRONMENT-SPECIFIC NUMBER
--
-- The first version of this file required United Bank Ltd to read balance 0
-- against a GL of 800,000, and bank_accounts to have exactly 18 columns
-- afterwards. Both are readings of dev. On production the same account reads a
-- GL of 0, so this migration would have aborted there on a fact about a
-- different database — the identical defect 0308 shipped with and had corrected
-- before it was applied.
--
-- What it asserts instead is environment-independent and stronger:
--
--   * every bank_accounts row is byte-identical before and after, in both
--     directions — DROPPING A COLUMN MUST NOT MOVE A BALANCE;
--   * the set of surviving column names equals the set that was there before,
--     minus exactly these two — so a drop that took a third column with it is
--     caught without hard-coding how many columns the table has;
--   * both hold on a replay, where the columns are already gone.

do $verify_before$
declare
  v_n int;
begin
  -- Refuse to run while anything still reads them. A drop that succeeds and
  -- breaks a caller at 3am is the outcome the whole staging exists to avoid,
  -- and CASCADE would hide exactly this.
  select count(*) into v_n from (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
    union all
    select 1 from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('v','m')
       and pg_get_viewdef(c.oid) ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
    union all
    select 1 from cron.job j
     where j.command ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
    union all
    select 1 from pg_attrdef d
     where pg_get_expr(d.adbin, d.adrelid) ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
    union all
    select 1 from pg_constraint k
     where k.contype = 'c'
       and pg_get_constraintdef(k.oid) ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
    union all
    select 1 from pg_index i
     where pg_get_indexdef(i.indexrelid) ~ '\m(auto_zero_monthly|last_zeroed_month)\M'
  ) r;
  if v_n <> 0 then
    raise exception
      '0311 REFUSES: % database object(s) still reference auto_zero_monthly or last_zeroed_month. Find them before dropping — this migration will not use CASCADE.', v_n;
  end if;

  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname = 'apply_monthly_account_zeroing') then
    raise exception '0311 REFUSES: apply_monthly_account_zeroing still exists — 0308 has not run. Order matters: the reader goes before the column.';
  end if;
end
$verify_before$;

-- Snapshots taken BEFORE the drop, so the assertions below compare against
-- what was actually there rather than against a number written by hand.
create temporary table zz_0311_before on commit drop as
  select id, bank_name, balance, opening_balance from public.bank_accounts;

create temporary table zz_0311_cols on commit drop as
  select column_name::text as column_name
    from information_schema.columns
   where table_schema = 'public' and table_name = 'bank_accounts'
     and column_name not in ('auto_zero_monthly', 'last_zeroed_month');

alter table public.bank_accounts drop column if exists auto_zero_monthly;
alter table public.bank_accounts drop column if exists last_zeroed_month;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_n int; v_bal numeric; v_gl numeric;
    begin
      -- 1. BOTH COLUMNS ARE GONE.
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'bank_accounts'
         and column_name in ('auto_zero_monthly', 'last_zeroed_month');
      if v_n <> 0 then
        raise exception '0311 FAILED: % of the 2 columns survive', v_n;
      end if;

      -- 2. AND NOTHING ELSE ON THE TABLE DID. Compared as a SET of column
      -- names against what was there before, not as a count: a hard-coded
      -- count is a reading of one database, and it is what the first version
      -- of this file got wrong.
      select count(*) into v_n from (
        select column_name from zz_0311_cols
        except
        select column_name::text from information_schema.columns
         where table_schema = 'public' and table_name = 'bank_accounts') d;
      if v_n <> 0 then
        raise exception '0311 FAILED: the drop took % other column(s) with it', v_n;
      end if;

      -- 3. EVERY ROW IS BYTE-IDENTICAL, BOTH DIRECTIONS. Dropping a column
      -- must not move a balance. A drop cannot lose rows, but a trigger fired
      -- by the ALTER could, and "it cannot happen" is not a check.
      select count(*) into v_n from (
        select * from zz_0311_before
        except all
        select id, bank_name, balance, opening_balance from public.bank_accounts) d;
      if v_n <> 0 then
        raise exception '0311 FAILED: % bank account row(s) changed or vanished', v_n;
      end if;

      select count(*) into v_n from (
        select id, bank_name, balance, opening_balance from public.bank_accounts
        except all
        select * from zz_0311_before) d;
      if v_n <> 0 then
        raise exception '0311 FAILED: % bank account row(s) appeared', v_n;
      end if;

      -- 4. THE EVIDENCE, REPORTED AND NOT ASSERTED. The figures differ by
      -- database — on dev United Bank Ltd reads 0 against a GL of 800,000, on
      -- production 0 against 0 — and neither is a property of this migration.
      for v_bal, v_gl in
        select ba.balance,
               coalesce((select sum(jl.debit - jl.credit)
                           from public.cash_locations cl
                           join public.journal_lines jl on jl.account_id = cl.coa_account_id
                          where cl.bank_account_id = ba.id and cl.coa_account_id is not null), 0)
          from public.bank_accounts ba
         where ba.bank_name = 'United Bank Ltd'
      loop
        raise notice '0311: United Bank Ltd left untouched — operational %, GL %', v_bal, v_gl;
      end loop;

      -- 5. AND THE LEDGER SUITE STILL RUNS ON EVERY COMPANY. bank_accounts is
      -- read by three of the twenty-five checks.
      select count(*) into v_n
        from public.companies c, lateral public.ledger_checks(c.id) l
       where l.check_name = 'checks_evaluated' and not l.passed;
      if v_n <> 0 then
        raise exception '0311 FAILED: the canary is red on % compan(ies) after the drop', v_n;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0311 verification failed: %', v_outcome;
  end if;
end
$verify$;
