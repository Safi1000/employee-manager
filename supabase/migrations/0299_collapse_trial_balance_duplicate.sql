-- 0299 — the check that says the ledger balances now reads the report that
-- shows it balancing.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- THE THIRD INSTANCE OF THE SAME SHAPE
--
-- public.trial_balance is the ledger's central report. NOTHING READS IT — not
-- the database, not the application, not a script (0294's view arm found it).
-- Meanwhile ledger_checks_base computes debits-equal-credits INLINE from
-- journal_lines, so the rule "the ledger balances" has two implementations:
--
--   trial_balance          per account and per branch, with names. Uninvoked.
--   ledger_checks_base tb  two totals, computed from the base tables. Invoked.
--
-- One is watched and one is not, and nothing forces them to agree. This is
-- attendance_gate_mode_residue (0289) and partner_client_breakdown before it,
-- for the third time, and this time it is in the trial balance.
--
-- The consequence is specific and bad: the report a person opens to see that
-- the books balance is not the artefact the check examines. They could
-- disagree, and the first anyone would know is an auditor asking why.
--
-- WHY THE GRANULARITIES DIFFER AND IT IS STILL SAFE
--
-- 0289's lesson was that a naive collapse silently changes a published figure
-- — the inline gate-mode check counted blocked ROWS while the function counted
-- EMPLOYEES, and both were zero, so the verdict agreed and the number did not.
--
-- Here the view groups by account and branch and the check wants two scalars,
-- so summing the view is the right reduction. The question is whether the view
-- can DROP a line the inline query counts, because the view inner-joins
-- chart_of_accounts:
--
--   journal_lines.account_id   NOT NULL
--   journal_lines_account_id_fkey  FOREIGN KEY (account_id)
--       REFERENCES chart_of_accounts(id) ON DELETE RESTRICT
--
-- It cannot. Every line has an account, and the account cannot be deleted
-- while a line references it. The inner join is total. That is a CONSTRAINT,
-- not a comment, and the verification below asserts both halves of it — so if
-- somebody ever makes account_id nullable or weakens the FK to SET NULL, this
-- collapse fails a replay instead of quietly under-counting the ledger.
--
-- branch_id IS nullable, and the view LEFT JOINs branches, so a line with no
-- branch is kept. Checked for the same reason.
--
-- Measured before and after on dev, all four companies:
--
--   inline  dr 37,930,888.48  cr 37,930,888.48   (SANDBOX TESTING ORG)
--   view    dr 37,930,888.48  cr 37,930,888.48
--   lines whose account_id has no chart_of_accounts row: 0
--
-- HOW
--
-- Surgery on the existing body, as 0289 did, rather than restating six hundred
-- lines. Restating would risk losing the 0287 tenant guard or a 0259 subtree
-- fix to a copy-paste, and this file would then be the authority on a function
-- it had silently altered.

do $collapse$
declare
  v_oid  oid;
  v_src  text;
  v_new  text;
  v_def  text;
  v_hdr  text;
  v_rest text;
  p1     int;
  p2     int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'ledger_checks_base';

  if v_src ~ 'public\.trial_balance' then
    raise notice '0299: already collapsed, nothing to do';
    return;                                    -- idempotent replay
  end if;

  v_new := regexp_replace(
    v_src,
    'tb as \(\s*select coalesce\(sum\(jl\.debit\), 0\) dr, coalesce\(sum\(jl\.credit\), 0\) cr\s*from public\.journal_lines jl\s*join public\.journal_entries je on je\.id = jl\.journal_entry_id\s*where je\.company_id = p_company_id\s*\),',
    'tb as ('
      || E'\n    -- 0299. ONE implementation. This summed journal_lines inline while'
      || E'\n    -- public.trial_balance computed the same thing per account and'
      || E'\n    -- nothing read it. The reduction is exact: account_id is NOT NULL'
      || E'\n    -- with an ON DELETE RESTRICT foreign key, so the view''s inner join'
      || E'\n    -- to chart_of_accounts cannot drop a line, and branches is LEFT'
      || E'\n    -- joined so an unbranched line is kept.'
      || E'\n    select coalesce(sum(t.total_debit), 0) dr, coalesce(sum(t.total_credit), 0) cr'
      || E'\n      from public.trial_balance t'
      || E'\n     where t.company_id = p_company_id'
      || E'\n  ),',
    'g');

  if v_new = v_src then
    raise exception '0299 FAILED: the inline tb CTE was not found — ledger_checks_base has changed shape, do not guess';
  end if;

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$collapse$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_co uuid; v_dr numeric; v_cr numeric;
      v_exp numeric; v_act numeric; v_rows int;
      v_def text; v_stub numeric;
    begin
      -- The company with journal activity, not simply the first one. A
      -- comparison of two zeroes proves nothing about a reduction.
      select je.company_id into v_co
        from public.journal_entries je
        join public.journal_lines jl on jl.journal_entry_id = je.id
       group by je.company_id
       order by count(*) desc
       limit 1;
      if v_co is null then
        raise exception '0299: no company has journal lines — this collapse cannot be verified here';
      end if;

      -- 1. IT NOW READS THE REPORT.
      if not exists (select 1 from pg_proc p
                      where p.pronamespace = 'public'::regnamespace
                        and p.proname = 'ledger_checks_base'
                        and p.prosrc ~ 'public\.trial_balance') then
        raise exception '0299 FAILED: ledger_checks_base does not read trial_balance';
      end if;

      -- 2. THE FIGURE DID NOT MOVE. Recompute the OLD inline expression BY
      -- HAND and require the check to still report exactly it — 0289's
      -- pattern, and the whole difference between a refactor and a change.
      select coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
        into v_dr, v_cr
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.journal_entry_id
       where je.company_id = v_co;

      select expected, actual into v_exp, v_act
        from public.ledger_checks(v_co)
       where check_name = 'trial_balance_debits_equal_credits';

      if v_exp is distinct from v_dr then
        raise exception '0299 FAILED: debits moved — inline said %, the collapsed check says %', v_dr, v_exp;
      end if;
      if v_act is distinct from v_cr then
        raise exception '0299 FAILED: credits moved — inline said %, the collapsed check says %', v_cr, v_act;
      end if;
      if v_dr = 0 then
        raise exception '0299 FAILED: the probe company has zero debits, so the match above is vacuous';
      end if;

      -- 3. THE REDUCTION IS TOTAL, AND THAT RESTS ON CONSTRAINTS RATHER THAN
      -- ON THIS COMMENT. If either half stops holding, the view can silently
      -- drop lines and the balance check goes green on an unbalanced ledger.
      if exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='journal_lines'
                    and column_name='account_id' and is_nullable='YES') then
        raise exception '0299 FAILED: journal_lines.account_id is nullable — the view inner-joins chart_of_accounts and would drop those lines';
      end if;
      if not exists (select 1 from pg_constraint
                      where conrelid='public.journal_lines'::regclass
                        and contype='f'
                        and pg_get_constraintdef(oid) like 'FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id)%'
                        and confdeltype = 'r') then
        raise exception '0299 FAILED: the account_id foreign key is missing or no longer ON DELETE RESTRICT — an account could be deleted out from under a line';
      end if;
      if exists (select 1 from public.journal_lines jl
                  join public.journal_entries je on je.id = jl.journal_entry_id
                 where not exists (select 1 from public.chart_of_accounts a where a.id = jl.account_id)) then
        raise exception '0299 FAILED: journal lines exist whose account is not in chart_of_accounts';
      end if;

      -- 4. THE SUITE STILL HAS ITS SHAPE.
      select count(*) into v_rows from public.ledger_checks(v_co);
      if v_rows <> 21 then
        raise exception '0299 FAILED: ledger_checks returned % rows, expected 21', v_rows;
      end if;

      -- 5. THE CHECK ACTUALLY READS THE VIEW. Proved by replacing the view
      -- with a stub that reports an imbalance and requiring the check to
      -- follow it. Data-independent on purpose, and restored before judging so
      -- a failure cannot leave a stub behind.
      v_def := pg_get_viewdef('public.trial_balance'::regclass, true);

      execute 'create or replace view public.trial_balance as
               select je.company_id, a.id as account_id, a.account_code, a.account_name,
                      a.account_type, a.parent_id, jl.branch_id, br.name as region_name,
                      sum(jl.debit) as total_debit,
                      sum(jl.credit) + 1 as total_credit,
                      (sum(jl.debit) - sum(jl.credit)) as net_debit
                 from public.journal_lines jl
                 join public.journal_entries je on je.id = jl.journal_entry_id
                 join public.chart_of_accounts a on a.id = jl.account_id
                 left join public.branches br on br.id = jl.branch_id
                group by je.company_id, a.id, a.account_code, a.account_name,
                         a.account_type, a.parent_id, jl.branch_id, br.name';

      select actual into v_stub from public.ledger_checks(v_co)
       where check_name = 'trial_balance_debits_equal_credits';

      execute 'create or replace view public.trial_balance as ' || v_def;

      -- The stub adds 1 per (account, branch) group, so credits must have
      -- RISEN. Reading the real figure back means the check never looked at
      -- the view at all.
      if v_stub is not distinct from v_cr then
        raise exception 'PROBE INSENSITIVE: stubbed trial_balance to overstate credits and the check still reported %', v_stub;
      end if;
      if v_stub <= v_cr then
        raise exception 'PROBE INSENSITIVE: stubbed credits should exceed %, the check reported %', v_cr, v_stub;
      end if;

      select actual into v_stub from public.ledger_checks(v_co)
       where check_name = 'trial_balance_debits_equal_credits';
      if v_stub is distinct from v_cr then
        raise exception 'PROBE DID NOT RESTORE: credits read %, expected %', v_stub, v_cr;
      end if;

      -- 6. trial_balance IS NO LONGER AN UNINVOKED VIEW. 0294 reported 14;
      -- this is the first of them to be decided.
      if exists (select 1 from public.uninvoked_controls()
                  where kind = 'view' and object_name = 'trial_balance') then
        raise exception '0299 FAILED: trial_balance is still reported as an uninvoked view';
      end if;
      select count(*) into v_rows from public.uninvoked_controls() where kind = 'view';
      if v_rows <> 13 then
        raise exception '0299 FAILED: the uninvoked view count is %, expected 13 (14 minus trial_balance)', v_rows;
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0299 verification failed: %', v_outcome;
  end if;
end
$verify$;
