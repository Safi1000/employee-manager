-- 0502 — Reversals, the foundation: one log, one permission, one snapshot.
--
-- DECIDED (2026-10-07, Shayan, "make all the decisions"): a Super Admin can
-- reverse a recorded action from one page. Every reversal is a function of its
-- own (0503 phase 1, 0504 phase 2, 0505 phase 3) and they share what is here.
--
-- THE RULES EVERY REVERSAL FOLLOWS
--
--   * The ledger is append-only. A reversal posts the opposite entry; it never
--     deletes or edits a journal line. Where an action already had a tested
--     undo (delete_invoice_payment, delete_expense, revert_vendor_payment ...)
--     the reversal CALLS it rather than restating it — those functions already
--     move the ledger and the balance together, and a second copy is where the
--     two would drift.
--   * Where the opposite entry lands is reverse_journal_for_source's rule, not
--     a new one: the original month if it is open, today if it is closed.
--   * Where an undo removes the source row (a payment, an expense, an advance),
--     the row as it stood is kept in reversals.before. Nothing disappears from
--     the record — it moves from the table into the reversal that explains it.
--   * Preview and execute are ONE function (p_preview). The popup shows exactly
--     what will run, because it is the same code returning before it writes.
--   * Blockers refuse; nothing cascades. A later record that depends on this one
--     is named, and is reversed first by hand.
--   * One reversal per state of a source. A source whose state can come back
--     (a payslip reversed, paid again, and found wrong again) is reversible
--     again; the same state twice is not. reversal_check is given the moment
--     the source reached its current state (p_since) and refuses if a reversal
--     already happened after it. A second click or a second tab is caught
--     there, and by the row lock each reverse_* takes on its source.
--   * A reversal cannot itself be reversed. Redo the original action instead.
--   * Permission: reversals.execute (Super Admin has it; it is grantable). The
--     area's own key is ALSO required, because the undo functions reversals
--     call keep their own require_perm — reversing a payment is still a
--     receivables act.
--
-- WHAT IS HERE
--
--   1. reversals.execute in permission_keys (mirrors PERMISSION_GROUPS).
--   2. reversals — the log.
--   3. employee_state_snapshots + its trigger. Firing deletes a guard's later
--      attendance (purge_attendance_after_separation) and closes or deletes his
--      postings (record_separation, transition_employee_lifecycle). An undo can
--      only put back what was saved first, so every exit and every rehire is
--      photographed BEFORE the update that causes those deletions. A BEFORE
--      trigger on employees, rather than an edit to record_separation, so both
--      exit paths are covered and no multi-author function is restated.
--   4. Helpers: reversal_check, reversal_finish, reverse_journal_entry,
--      reversal_result.

-- 1 ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label)
values ('reversals.execute', 'Settings & Users', 'Reverse recorded actions (Reversals page)')
on conflict (key) do nothing;

-- 2 ---------------------------------------------------------------------------
create table if not exists public.reversals (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null,
  kind             text not null,
  source_id        uuid not null,
  title            text,
  mode             text not null default 'error' check (mode in ('error', 'recover')),
  reason           text not null check (length(btrim(reason)) >= 5),
  reversed_by      uuid default auth.uid(),
  reversed_by_name text,
  reversed_at      timestamptz not null default now(),
  before           jsonb,
  effects          jsonb not null default '[]'::jsonb
);

comment on table public.reversals is
  '0502: one row per reversed action. before = the source row as it stood (kept here when the undo removes it); effects = what the reversal did, as shown in its preview. Written only by the reverse_* functions.';

create index if not exists idx_reversals_company_at on public.reversals(company_id, reversed_at desc);
create index if not exists idx_reversals_source on public.reversals(kind, source_id, reversed_at desc);

alter table public.reversals enable row level security;

drop policy if exists company_members on public.reversals;
create policy company_members on public.reversals for select to authenticated
  using (company_id = public.current_company_id() and public.has_perm('reversals.execute'));
drop policy if exists ssa_all on public.reversals;
create policy ssa_all on public.reversals for select to authenticated
  using (public.is_ssa_unscoped());

grant select on public.reversals to authenticated;

-- 3 ---------------------------------------------------------------------------
create table if not exists public.employee_state_snapshots (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  kind         text not null check (kind in ('separation', 'rehire')),
  from_state   text,
  to_state     text,
  taken_at     timestamptz not null default now(),
  taken_by     uuid default auth.uid(),
  employee     jsonb not null,           -- the employees row before the change
  deployments  jsonb not null default '[]'::jsonb,  -- his open postings before it
  attendance   jsonb not null default '[]'::jsonb   -- days a separation purges
);

comment on table public.employee_state_snapshots is
  '0502: what an exit or a rehire changed, saved before it changed it, so reverse_separation / reverse_rehire can put it back. Written by trg_aaa_snapshot_employee_state only.';

create index if not exists idx_ess_employee on public.employee_state_snapshots(employee_id, taken_at desc);

alter table public.employee_state_snapshots enable row level security;
drop policy if exists company_members on public.employee_state_snapshots;
create policy company_members on public.employee_state_snapshots for select to authenticated
  using (company_id = public.current_company_id() and public.has_perm('reversals.execute'));
grant select on public.employee_state_snapshots to authenticated;

create or replace function public.snapshot_employee_state()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_exit   text[] := array['left', 'terminated', 'fired', 'absconded'];
  v_kind   text;
  v_cutoff date;
begin
  -- A reversal restoring the row is not a new exit or rehire to photograph.
  if coalesce(current_setting('app.reversal', true), '') = 'on' then
    return new;
  end if;

  if not (old.lifecycle_state::text = any (v_exit)) and new.lifecycle_state::text = any (v_exit) then
    v_kind := 'separation';
  elsif old.lifecycle_state::text = any (v_exit) and new.lifecycle_state::text = 'active' then
    v_kind := 'rehire';
  else
    return new;
  end if;

  -- The same cutoff purge_attendance_after_separation will use, from NEW.
  v_cutoff := least(coalesce(new.last_working_day, 'infinity'::date),
                    coalesce(new.termination_date - 1, 'infinity'::date));

  insert into public.employee_state_snapshots
    (company_id, employee_id, kind, from_state, to_state, employee, deployments, attendance)
  values (
    old.company_id, old.id, v_kind, old.lifecycle_state::text, new.lifecycle_state::text,
    to_jsonb(old),
    coalesce((select jsonb_agg(to_jsonb(d)) from public.deployments d
               where d.guard_id = old.id and d.end_date is null), '[]'::jsonb),
    case when v_kind = 'separation' and v_cutoff <> 'infinity'::date then
      coalesce((select jsonb_agg(to_jsonb(a) order by a.attendance_date) from public.attendance_records a
                 where a.employee_id = old.id and a.attendance_date > v_cutoff), '[]'::jsonb)
    else '[]'::jsonb end);
  return new;
end;
$function$;

drop trigger if exists trg_aaa_snapshot_employee_state on public.employees;
create trigger trg_aaa_snapshot_employee_state
  before update of lifecycle_state on public.employees
  for each row execute function public.snapshot_employee_state();

-- 4 ---------------------------------------------------------------------------
-- reversal_check: the permission, the one-reversal-per-source rule, and the
-- reason. INVOKER and revoked from callers: it is only ever run from inside a
-- reverse_* function, under that function's owner.
create or replace function public.reversal_check(p_kind text, p_source_id uuid, p_reason text, p_preview boolean,
                                                  p_since timestamptz default null)
returns void
language plpgsql
set search_path to 'public'
as $function$
begin
  perform public.require_perm('reversals.execute');
  if exists (select 1 from public.reversals r
              where r.kind = p_kind and r.source_id = p_source_id
                and r.reversed_at >= coalesce(p_since, '-infinity'::timestamptz)) then
    raise exception 'This has already been reversed. A reversal cannot be repeated.' using errcode = 'P0001';
  end if;
  if not coalesce(p_preview, false) and length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Say why this is being reversed (a few words at least).' using errcode = 'P0001';
  end if;
end;
$function$;

-- reversal_result: the one shape every reverse_* function returns, preview or
-- done. Raises instead when blockers stand and this is not a preview, so a
-- reversal that the preview would have refused can never run.
create or replace function public.reversal_result(
  p_kind text, p_source_id uuid, p_title text, p_blockers text[], p_effects text[],
  p_preview boolean, p_reversal_id uuid default null)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
begin
  if not coalesce(p_preview, false) and coalesce(cardinality(p_blockers), 0) > 0 and p_reversal_id is null then
    raise exception 'Cannot reverse: %', array_to_string(p_blockers, ' ') using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'kind', p_kind, 'source_id', p_source_id, 'title', p_title,
    'blockers', to_jsonb(coalesce(p_blockers, '{}'::text[])),
    'effects', to_jsonb(coalesce(p_effects, '{}'::text[])),
    'done', p_reversal_id is not null, 'reversal_id', p_reversal_id);
end;
$function$;

-- reversal_finish: write the log row.
create or replace function public.reversal_finish(
  p_company uuid, p_kind text, p_source_id uuid, p_title text, p_mode text, p_reason text,
  p_before jsonb, p_effects text[])
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare v_id uuid; v_name text;
begin
  select coalesce(nullif(btrim(full_name), ''), email) into v_name from public.profiles where id = auth.uid();
  insert into public.reversals
    (company_id, kind, source_id, title, mode, reason, reversed_by_name, before, effects)
  values (p_company, p_kind, p_source_id, p_title, coalesce(p_mode, 'error'), btrim(p_reason), v_name,
          p_before, to_jsonb(coalesce(p_effects, '{}'::text[])))
  returning id into v_id;
  return v_id;
end;
$function$;

-- reverse_journal_entry: ONE entry, for the cases where reverse_journal_for_source
-- would take too much. A write-off posts with source ('invoices', invoice id) —
-- the same source as the invoice's own revenue — so reversing by source would
-- reverse the sale as well. Same landing rule as reverse_journal_for_source.
create or replace function public.reverse_journal_entry(p_entry_id uuid, p_note text default null)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
declare v_e record; v_rev uuid := gen_random_uuid(); v_date date;
begin
  select * into v_e from public.journal_entries where id = p_entry_id;
  if v_e.id is null then raise exception 'That journal entry no longer exists.' using errcode = 'P0001'; end if;
  if v_e.is_reversal then raise exception 'That entry is itself a reversal.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.journal_entries r where r.reversal_of_entry_id = v_e.id) then
    raise exception 'That entry has already been reversed.' using errcode = 'P0001';
  end if;

  v_date := case when public.is_period_closed(v_e.company_id, v_e.entry_date) then current_date else v_e.entry_date end;

  insert into public.journal_entries
    (id, company_id, entry_date, description, source_table, source_id,
     is_reversal, posted_by, status, posting_period, reversal_of_entry_id)
  values
    (v_rev, v_e.company_id, v_date,
     v_e.description || ' (reversal' || coalesce(' — ' || p_note, '') || ')'
       || case when v_date <> v_e.entry_date
               then ' — original period ' || to_char(v_e.entry_date, 'YYYY-MM') || ' is closed' else '' end,
     v_e.source_table, v_e.source_id, true, auth.uid(),
     'posted', date_trunc('month', v_date)::date, v_e.id);

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, branch_id,
     client_id, employee_id, partner_id, contract_id, cost_center)
  select v_rev, jl.account_id, jl.credit, jl.debit, jl.branch_id,
         jl.client_id, jl.employee_id, jl.partner_id, jl.contract_id, jl.cost_center
    from public.journal_lines jl
   where jl.journal_entry_id = v_e.id;
  return v_rev;
end;
$function$;

-- The helpers act only under a reverse_* function's owner. Nobody calls them.
revoke execute on function public.reversal_check(text, uuid, text, boolean, timestamptz) from public, anon, authenticated;
revoke execute on function public.reversal_result(text, uuid, text, text[], text[], boolean, uuid) from public, anon, authenticated;
revoke execute on function public.reversal_finish(uuid, text, uuid, text, text, text, jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.reverse_journal_entry(uuid, text) from public, anon, authenticated;
revoke execute on function public.snapshot_employee_state() from public, anon, authenticated;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0502 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
