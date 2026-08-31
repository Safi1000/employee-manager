-- 0220 — Narrow the ledger immutability escape hatch.
--
-- 0219 trusted any session with no company context (`current_company_id() is
-- null`). That is far too broad: it covers every service-role call, not just
-- migrations. Replaced with an explicit, role-gated maintenance flag.
--
-- Also converts the source-record cascades into the journal tables to RESTRICT,
-- and repairs a regression 0219 introduced in the manual-journal UI.

-- ---------------------------------------------------------------------------
-- 1. Explicit, role-gated maintenance flag.
--
-- Two factors, both required:
--   (a) the session sets  app.ledger_maintenance = 'on'
--   (b) session_user is a privileged role (superuser or BYPASSRLS)
--
-- session_user, NOT current_user: SECURITY DEFINER functions (post_journal and
-- friends are owned by postgres) rewrite current_user, so a role gate on
-- current_user would pass for every app request routed through one. session_user
-- is the role that actually opened the connection and cannot be inflated.
--
-- In Supabase, PostgREST connects as `authenticator` (no superuser, no
-- BYPASSRLS) and then SET ROLE authenticated, so an app request can never
-- satisfy (b) even if it somehow set the GUC. Migrations and psql connect as
-- `postgres`, which can.
--
-- Maintenance procedure for touching posted journal rows (including company
-- teardown, which now needs an explicit ledger purge — see section 3):
--
--   begin;
--     set local app.ledger_maintenance = 'on';
--     ... corrective statements ...
--   commit;
-- ---------------------------------------------------------------------------

create or replace function public.is_ledger_maintenance()
returns boolean
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(current_setting('app.ledger_maintenance', true), '') = 'on'
     and exists (
       select 1 from pg_roles
        where rolname = session_user
          and (rolsuper or rolbypassrls)
     );
$function$;

comment on function public.is_ledger_maintenance() is
  'True only when a privileged session (by session_user, not current_user) has explicitly set app.ledger_maintenance = on. Gates every mutation of a posted journal row.';

-- ---------------------------------------------------------------------------
-- 2. Immutability now keys off the maintenance flag, and covers reversed
--    entries as well as posted ones.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_journal_immutable()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if public.is_ledger_maintenance() then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'journal_entries' then
    if tg_op = 'DELETE' then
      raise exception
        'Journal entry % cannot be deleted. Post a reversing entry instead.', old.id
        using errcode = 'P0001',
              hint = 'Server maintenance requires: set local app.ledger_maintenance = ''on''.';
    end if;

    -- Only status may move (posted -> reversed). Everything else is frozen once
    -- the entry has left draft.
    if old.status in ('posted', 'reversed') and (
         new.id             is distinct from old.id
      or new.company_id     is distinct from old.company_id
      or new.entry_date     is distinct from old.entry_date
      or new.description    is distinct from old.description
      or new.source_table   is distinct from old.source_table
      or new.source_id      is distinct from old.source_id
      or new.is_reversal    is distinct from old.is_reversal
      or new.posting_period is distinct from old.posting_period
      or new.reversal_of_entry_id is distinct from old.reversal_of_entry_id)
    then
      raise exception
        'Posted journal entry % is immutable. Post a reversing entry instead.', old.id
        using errcode = 'P0001',
              hint = 'Server maintenance requires: set local app.ledger_maintenance = ''on''.';
    end if;
    return new;
  end if;

  -- journal_lines: frozen once the parent entry has left draft.
  if exists (
    select 1 from public.journal_entries je
     where je.id = coalesce(old.journal_entry_id, new.journal_entry_id)
       and je.status in ('posted', 'reversed'))
  then
    raise exception
      'Journal lines of a posted entry are immutable. Post a reversing entry instead.'
      using errcode = 'P0001',
            hint = 'Server maintenance requires: set local app.ledger_maintenance = ''on''.';
  end if;
  return coalesce(new, old);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Cascade paths into the journal tables — enumerated and justified.
--
--   journal_entries.company_id     -> companies        CASCADE  => RESTRICT
--       Deleting a tenant silently destroyed its entire ledger. Company
--       teardown must now purge the ledger explicitly under maintenance mode:
--         begin;
--           set local app.ledger_maintenance = 'on';
--           delete from journal_entries where company_id = '<id>';  -- lines cascade
--           delete from companies where id = '<id>';
--         commit;
--
--   journal_lines.journal_entry_id -> journal_entries  CASCADE  => KEEP
--       Composition, not a source-record cascade: an entry and its lines are
--       one object. The entry itself is protected by the immutability trigger,
--       so lines can only disappear with their parent, under maintenance mode.
--
--   journal_lines.client_id        -> clients          SET NULL => RESTRICT
--   journal_lines.employee_id      -> employees        SET NULL => RESTRICT
--   journal_lines.partner_id       -> partners         SET NULL => RESTRICT
--   journal_lines.contract_id      -> contracts        SET NULL => RESTRICT
--       Introduced by 0219. SET NULL would silently strip dimensions off
--       posted lines — and, since 0219, would instead fail inside the
--       immutability trigger with a confusing error. A master record with
--       ledger history must not be deletable at all.
--
--   journal_lines.account_id       -> chart_of_accounts RESTRICT => KEEP (correct)
--   journal_lines.branch_id        -> branches          NO ACTION => RESTRICT
--       Made explicit; NO ACTION only differs by deferrability.
--   journal_entries.reversal_of_entry_id -> journal_entries NO ACTION => KEEP
--       Self-reference; the parent cannot be deleted anyway.
-- ---------------------------------------------------------------------------

alter table public.journal_entries
  drop constraint if exists journal_entries_company_id_fkey;
alter table public.journal_entries
  add constraint journal_entries_company_id_fkey
  foreign key (company_id) references public.companies(id) on delete restrict;

alter table public.journal_lines
  drop constraint if exists journal_lines_client_id_fkey;
alter table public.journal_lines
  add constraint journal_lines_client_id_fkey
  foreign key (client_id) references public.clients(id) on delete restrict;

alter table public.journal_lines
  drop constraint if exists journal_lines_employee_id_fkey;
alter table public.journal_lines
  add constraint journal_lines_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete restrict;

alter table public.journal_lines
  drop constraint if exists journal_lines_partner_id_fkey;
alter table public.journal_lines
  add constraint journal_lines_partner_id_fkey
  foreign key (partner_id) references public.partners(id) on delete restrict;

alter table public.journal_lines
  drop constraint if exists journal_lines_contract_id_fkey;
alter table public.journal_lines
  add constraint journal_lines_contract_id_fkey
  foreign key (contract_id) references public.contracts(id) on delete restrict;

alter table public.journal_lines
  drop constraint if exists journal_lines_branch_id_fkey;
alter table public.journal_lines
  add constraint journal_lines_branch_id_fkey
  foreign key (branch_id) references public.branches(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 4. Regression fix: manual journal entries.
--
-- ChartOfAccounts.tsx inserted the entry and its lines in two separate
-- PostgREST calls — two transactions. 0219's deferred balance check fires at
-- the end of the first one, when the entry still has no lines, so the manual
-- entry form broke. Route it through post_journal instead: one transaction,
-- balanced by construction.
--
-- post_journal gains p_manual. Dropped and recreated rather than overloaded so
-- only one version of the function exists; all existing callers pass positional
-- args up to p_region_id and are unaffected.
-- ---------------------------------------------------------------------------

drop function if exists public.post_journal(uuid, date, text, text, uuid, boolean, jsonb, uuid);

create function public.post_journal(
  p_company_id uuid, p_date date, p_description text,
  p_source_table text, p_source_id uuid, p_is_reversal boolean,
  p_lines jsonb, p_region_id uuid default null::uuid,
  p_manual boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_key      text;
  v_debit    numeric;
  v_credit   numeric;
  v_region   uuid;
  v_any      boolean := false;
  v_user     uuid;
  v_dr_total numeric := 0;
  v_cr_total numeric := 0;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  p_region_id := coalesce(p_region_id, public.head_office_region(p_company_id));
  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);

    if v_debit = 0 and v_credit = 0 then continue; end if;

    v_key := v_line->>'key';
    v_acct_id := coalesce(
      nullif(v_line->>'account_id', '')::uuid,
      public.coa_id(p_company_id, v_key)
    );

    if v_acct_id is null then
      raise exception
        'post_journal: cannot resolve account for company % (system_key=%, source=%/%). Seed the chart of accounts.',
        p_company_id, coalesce(v_key, '<null>'), p_source_table, p_source_id
        using errcode = '23503';
    end if;

    v_region := coalesce(nullif(v_line->>'region', '')::uuid, p_region_id);

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id,
         is_reversal, manual, posted_by, status, posting_period)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id,
         p_is_reversal, coalesce(p_manual, false), v_user, 'posted',
         date_trunc('month', p_date)::date);
      v_any := true;
    end if;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, branch_id,
       client_id, employee_id, partner_id, contract_id, cost_center)
    values
      (v_entry_id, v_acct_id, v_debit, v_credit, v_region,
       nullif(v_line->>'client_id',   '')::uuid,
       nullif(v_line->>'employee_id', '')::uuid,
       nullif(v_line->>'partner_id',  '')::uuid,
       nullif(v_line->>'contract_id', '')::uuid,
       nullif(v_line->>'cost_center', ''));

    v_dr_total := v_dr_total + v_debit;
    v_cr_total := v_cr_total + v_credit;
  end loop;

  if not v_any then return null; end if;

  if v_dr_total <> v_cr_total then
    raise exception
      'post_journal: entry does not balance (debits % <> credits %) for source %/%',
      v_dr_total, v_cr_total, p_source_table, p_source_id
      using errcode = '23514';
  end if;

  return v_entry_id;
end;
$function$;

create or replace function public.post_manual_journal(
  p_entry_date date, p_description text,
  p_debit_account_id uuid, p_credit_account_id uuid,
  p_amount numeric, p_branch_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_company uuid := public.current_company_id();
begin
  if v_company is null then
    raise exception 'Not authorised for any company';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if p_debit_account_id is null or p_credit_account_id is null then
    raise exception 'Select both a debit and a credit account';
  end if;
  if p_debit_account_id = p_credit_account_id then
    raise exception 'Debit and credit accounts must differ';
  end if;

  perform 1 from public.chart_of_accounts
   where id in (p_debit_account_id, p_credit_account_id)
     and company_id = v_company
  having count(*) = 2;
  if not found then
    raise exception 'Account not found for this company';
  end if;

  return public.post_journal(
    v_company, p_entry_date,
    coalesce(nullif(btrim(p_description), ''), 'Manual adjustment'),
    null, null, false,
    jsonb_build_array(
      jsonb_build_object('account_id', p_debit_account_id,  'debit', p_amount, 'credit', 0),
      jsonb_build_object('account_id', p_credit_account_id, 'debit', 0,        'credit', p_amount)
    ),
    p_branch_id,
    true);
end;
$function$;

revoke all on function public.post_manual_journal(date, text, uuid, uuid, numeric, uuid) from public;
grant execute on function public.post_manual_journal(date, text, uuid, uuid, numeric, uuid) to authenticated;
