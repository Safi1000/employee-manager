-- 0245 — Close the INSERT hole in journal_lines. Two guards, neither
-- substituting for the other.
--
-- DEV ONLY.
--
-- WHAT WAS OPEN
--
-- enforce_journal_immutable is attached BEFORE DELETE OR UPDATE. It blocks the
-- two verbs that rewrite history and says nothing about the one that adds to
-- it. enforce_period_lock is not attached to journal_lines at all — it reads
-- ($1).<date_col> and ($1).company_id off the row, and journal_lines has
-- neither.
--
-- So a balanced pair of lines could be appended to an already-posted entry, in
-- any period. Demonstrated as a real authenticated tenant user, with both
-- controls firing in the same transaction:
--
--   CTRL1 line UPDATE                    : refused (immutability engaged)
--   CTRL2 header INSERT in closed month  : refused (period lock engaged)
--   TEST  append balanced pair to a
--         POSTED entry in a CLOSED month : ACCEPTED
--         entry debits 48,533 -> 53,533
--
-- Balanced, so assert_journal_balanced has nothing to say. Survives
-- `set constraints all immediate`, so it is what a real COMMIT gives.
-- `authenticated` holds INSERT on journal_lines and the via_entry policy admits
-- any entry belonging to current_company_id().
--
-- THE CONSTRAINT THAT SHAPES THE FIX
--
-- "Block INSERT when the parent entry is posted" would break posting itself.
-- post_journal inserts the journal_entries header with status='posted' on the
-- first line of its loop and THEN inserts the lines, so at line-insert time the
-- parent is always already posted. reverse_journal_for_source does the same.
--
-- What separates a legitimate line from an appended one is not the parent's
-- status — it is WHEN the parent was created. A line written as part of its
-- entry's original posting is written in the same transaction that created the
-- entry. A line appended afterwards, by definition, is not.
--
--   je.created_at >= now()
--
-- That is a structural fact about the row, not a policy flag someone can set,
-- and it needs no carve-out predicate to keep narrow. `now()` is the
-- TRANSACTION timestamp, so it is stable for the whole transaction and every
-- subtransaction inside it.
--
-- THE FIRST ATTEMPT USED `je.xmin = txid_current()::text::xid` AND BROKE
-- POSTING. Every plpgsql BEGIN ... EXCEPTION block is a subtransaction with its
-- own xid, so a row inserted inside one carries the SUBtransaction's xmin while
-- txid_current() returns the top-level id. post_journal is essentially always
-- called from inside such a block. Measured rather than reasoned, after the
-- migration's own control caught it:
--
--   at top level,      xmin = txid_current() : t
--   in a subtransaction, xmin = txid_current() : f     <- the bug
--   in a subtransaction, created_at >= now()  : t
--   pre-existing row,    created_at >= now()  : f
--
-- The control that caught it is the one asserting post_journal STILL WORKS. A
-- refusal-only verification would have shipped a guard that blocked all
-- posting.
--
-- TWO GUARDS, DELIBERATELY
--
--   * enforce_journal_immutable now covers INSERT on journal_lines. It stops
--     appending to a posted entry REGARDLESS OF PERIOD. This is the one that
--     matters most, because the open-period case is live today.
--
--   * enforce_period_lock_journal_lines stops closed-month line writes,
--     resolving the period through journal_entry_id -> journal_entries.entry_date.
--     It also, unlike immutability, does NOT honour the maintenance session —
--     matching enforce_period_lock's behaviour on the other seven tables, so a
--     maintenance session still cannot write a closed month.
--
-- Neither substitutes for the other: the first is period-blind and
-- maintenance-aware, the second is period-aware and maintenance-blind.
--
-- TRIGGER ORDER. Triggers fire alphabetically, so trg_journal_lines_immutable
-- runs before trg_journal_lines_period_lock. That is the order we want: an
-- append to a posted entry is wrong whether or not the month is closed, so the
-- immutability message is the more accurate one to surface.

-- ---------------------------------------------------------------------------
-- 1. Immutability now covers INSERT — on journal_lines only.
--
-- NOT on journal_entries, where INSERT is how an entry gets posted in the first
-- place. The trigger below is added to journal_lines alone; journal_entries
-- keeps its existing DELETE-OR-UPDATE attachment untouched.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_journal_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_parent_new boolean;
begin
  if public.is_maintenance_session() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    -- Only reachable from journal_lines; journal_entries has no INSERT
    -- attachment. A line belongs to its entry's original posting if and only if
    -- the entry was created in this same transaction. now() is the TRANSACTION
    -- timestamp, so this holds inside subtransactions too — see the header for
    -- why xmin does not.
    select (je.created_at >= now())
      into v_parent_new
      from public.journal_entries je
     where je.id = new.journal_entry_id;

    if v_parent_new is null then
      raise exception
        'Journal line references an entry that does not exist. [%]', tg_table_name
        using errcode = '23503';
    end if;

    if v_parent_new then
      return new;
    end if;

    raise exception
      'Posted journal rows are immutable. Lines cannot be added to an entry that was already posted — reverse the entry instead, or run under a maintenance session. [%]',
      tg_table_name
      using errcode = '23514';
  end if;

  raise exception
    'Posted journal rows are immutable. Reverse the entry instead, or run under a maintenance session.'
    using errcode = '23514';
end;
$fn$;

drop trigger if exists trg_journal_lines_immutable on public.journal_lines;
create trigger trg_journal_lines_immutable
  before insert or update or delete on public.journal_lines
  for each row execute function public.enforce_journal_immutable();

-- ---------------------------------------------------------------------------
-- 2. The period lock, resolved through the parent entry.
--
-- A separate function rather than a new tg_argv on enforce_period_lock: that
-- one reads the date and company straight off the row, and journal_lines has
-- neither column. Bending it to take an indirection would complicate the path
-- all seven other tables depend on.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_period_lock_journal_lines()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_entry uuid;
  v_date  date;
  v_co    uuid;
  v_ret   public.journal_lines;
begin
  -- OLD is unassigned on INSERT and NEW on DELETE, and plpgsql evaluates both
  -- arms of coalesce(), so `coalesce(new, old)` raises "record is not assigned
  -- yet" rather than doing the obvious thing. Branch explicitly.
  if tg_op = 'DELETE' then
    v_ret := old;
  else
    v_ret := new;
  end if;

  -- Same early return as enforce_period_lock: with no tenant identity there is
  -- no company whose periods could be closed. Migrations and service_role reach
  -- this; they are governed by the maintenance discipline, not by this trigger.
  if public.current_company_id() is null and not public.is_ssa_unscoped() then
    return v_ret;
  end if;

  v_entry := v_ret.journal_entry_id;

  select je.entry_date, je.company_id into v_date, v_co
    from public.journal_entries je where je.id = v_entry;

  if v_date is null then
    return v_ret;   -- no parent: the FK will refuse it anyway
  end if;

  if public.is_period_closed(v_co, v_date) then
    raise exception
      'Period for % is closed. Journal lines in a closed month cannot be added, changed or removed; reopen the month in Period Close first. [%]',
      v_date, tg_table_name
      using errcode = 'P0001';
  end if;

  return v_ret;
end;
$fn$;

drop trigger if exists trg_journal_lines_period_lock on public.journal_lines;
create trigger trg_journal_lines_period_lock
  before insert or update or delete on public.journal_lines
  for each row execute function public.enforce_period_lock_journal_lines();

comment on function public.enforce_period_lock_journal_lines() is
  'Period lock for journal_lines, which carries no date or company column of its own — both are resolved through journal_entry_id. Separate from enforce_period_lock so the seven direct attachments keep their simpler path. Does not honour the maintenance session, matching the other seven.';

-- ---------------------------------------------------------------------------
-- 3. Verification. Every case has a control proving the mechanism was engaged,
-- and every guard is shown able to refuse AND able to permit — a guard that
-- refuses everything would break posting entirely and still pass a
-- refusal-only check.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_outcome text;
begin
  -- Everything below runs inside a plpgsql subtransaction: the block ends with
  -- a deliberate raise, the handler catches it, and every write it made — the
  -- control posting, the closed period — is rolled back with it. A verification
  -- that leaves a journal entry behind has changed the ledger it was checking.
  begin
    declare
      v_co uuid; v_profile uuid; v_acct uuid; v_je uuid; v_msg text;
      v_month date; v_ok boolean;
    begin
      perform set_config('app.ledger_maintenance', 'off', true);

      select c.id into v_co from public.companies c
       where exists (select 1 from public.journal_entries je where je.company_id = c.id)
       limit 1;
      select p.id into v_profile from public.profiles p
       where p.company_id = v_co and coalesce(p.role::text,'') <> 'super_super_admin' limit 1;
      if v_co is null or v_profile is null then
        raise exception '0245 cannot self-test: needs a company with journal entries and a non-SSA profile';
      end if;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_profile::text, 'role','authenticated')::text, true);

      select je.id, je.entry_date into v_je, v_month
        from public.journal_entries je where je.company_id = v_co order by je.entry_date limit 1;
      select jl.account_id into v_acct
        from public.journal_lines jl where jl.journal_entry_id = v_je limit 1;

      -- CONTROL: posting a NEW entry must still work. If this fails the
      -- migration has broken the ledger and every refusal below is worthless.
      begin
        perform public.post_journal(
          v_co, current_date, '0245 self-test', 'manual', null, false,
          jsonb_build_array(
            jsonb_build_object('account_id', v_acct, 'debit', 10, 'credit', 0),
            jsonb_build_object('account_id', v_acct, 'debit', 0,  'credit', 10)),
          null, true);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        raise exception '0245 BROKE POSTING: post_journal now fails (%)', v_msg;
      end;

      -- THE FIX: appending to an already-posted entry is refused in an OPEN
      -- period, with no period closed anywhere.
      v_ok := false;
      begin
        insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
        values (v_je, v_acct, 5000, 0), (v_je, v_acct, 0, 5000);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg like '%immutable%');
      end;
      if not v_ok then
        raise exception '0245 FAILED: lines can still be appended to a posted entry (msg: %)',
          coalesce(v_msg, '<no error at all>');
      end if;

      -- The period-lock half, which must refuse even a maintenance session.
      insert into public.accounting_periods (company_id, period_month, closed_at)
      values (v_co, date_trunc('month', v_month)::date, now());

      perform set_config('app.ledger_maintenance', 'on', true);
      v_ok := false;
      begin
        insert into public.journal_lines (journal_entry_id, account_id, debit, credit)
        values (v_je, v_acct, 7000, 0), (v_je, v_acct, 0, 7000);
      exception when others then
        get stacked diagnostics v_msg = message_text;
        v_ok := (v_msg like '%closed%');
      end;
      if not v_ok then
        raise exception '0245 FAILED: a maintenance session can still write journal lines into a closed month (msg: %)',
          coalesce(v_msg, '<no error at all>');
      end if;
      perform set_config('app.ledger_maintenance', 'off', true);

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0245 verification failed: %', v_outcome;
  end if;
end
$verify$;
