-- 0384 — the permission catalogue, and a check that every key a body demands
--        appears in it.
--
-- ===========================================================================
-- TWICE NOW
-- ===========================================================================
--
-- 0361: post_profit_allocation required `partnership.post`. The key was never
-- added to PERMISSION_GROUPS, so the grant screen could not offer it, so the
-- only people who could post a partnership run were the two roles has_perm()
-- waves through outright.
--
-- 0384's cause: transition_record_state accepts `employees.ops_verify` as an
-- alternative to its role list. That key is not in PERMISSION_GROUPS either.
-- It has never been grantable to anybody, so the alternative has never once
-- been taken and the role list has been the only gate the whole time.
--
--   A PERMISSION THE DATABASE DEMANDS AND THE GRANT SCREEN CANNOT OFFER IS A
--   PERMISSION NOBODY CAN BE GIVEN.
--
-- It fails in the quietest possible way: has_perm() returns false, the caller
-- is refused, and the refusal looks exactly like a correctly-denied request.
-- Nothing distinguishes "you were not granted this" from "nobody can be".
--
-- ===========================================================================
-- THE CHECK
-- ===========================================================================
--
-- permission_keys is the catalogue, seeded from PERMISSION_GROUPS in
-- src/app/lib/supabase.ts. permission_keys_demanded() reads every key actually
-- required — from require_perm()/has_perm() in any function body, and from
-- has_perm() inside any RLS policy — and permission_key_gaps() reports the
-- difference.
--
-- The direction matters: it reports keys DEMANDED but not CATALOGUED, which is
-- the failure that silently locks people out. The reverse (catalogued but
-- unused) is not a defect — a key can be granted for a screen that gates
-- itself in the frontend — so it is deliberately not reported.
--
-- The catalogue is a copy, and a copy can drift. What keeps it honest is that
-- drift in the direction that HURTS is exactly what this check reports: add a
-- key to the database without adding it to the screen and the check goes red
-- that night.

create table if not exists public.permission_keys (
  key         text primary key,
  grp         text not null,
  label       text not null,
  created_at  timestamptz not null default now()
);

alter table public.permission_keys enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname='public' and tablename='permission_keys'
                    and policyname='readable_by_authenticated') then
    -- Readable by anyone signed in: it is a list of key names, and the grant
    -- screen has to render it. Writable by nobody through the API — this table
    -- changes by migration, alongside the code it mirrors.
    create policy readable_by_authenticated on public.permission_keys
      for select to authenticated using (true);
  end if;
end $$;

insert into public.permission_keys (key, grp, label) values
  ('employees.view',        'Employees',            'View employees'),
  ('employees.edit',        'Employees',            'Add / edit / delete employees'),
  ('attendance.view',       'Attendance',           'View attendance'),
  ('attendance.edit',       'Attendance',           'Mark / edit attendance'),
  ('attendance.bulk_mark',  'Attendance',           'Bulk-mark attendance per employee (calendar)'),
  ('attendance.backdate',   'Attendance',           'Backdate attendance past the marking cutoff'),
  ('attendance.ops_verify', 'Attendance',           'OPS-verify a finished month''s attendance'),
  ('payroll.view',          'Payroll',              'View payroll'),
  ('payroll.edit',          'Payroll',              'Edit / disburse payroll'),
  ('payroll.approve',       'Payroll',              'Approve payroll runs (COO/Finance sign-off)'),
  ('performance.approve',   'Payroll',              'Approve performance (enrollment, appraisals, bonus pools)'),
  ('banks.view',            'Banks & Accounting',   'View bank accounts & cash custody'),
  ('receivables.view',      'Banks & Accounting',   'View client receivables'),
  ('payables.view',         'Banks & Accounting',   'View accounts payable'),
  ('accounting.edit',       'Banks & Accounting',   'Edit banks, transfers, reconciliation'),
  ('expenses.view',         'Expenses',             'View expenses & advances'),
  ('expenses.edit',         'Expenses',             'Add / edit expenses & advances'),
  ('expenses.approve',      'Expenses',             'Approve / unapprove expenses (locks them)'),
  ('invoices.view',         'Invoices',             'View invoices'),
  ('invoices.edit',         'Invoices',             'Create / edit invoices & payments'),
  ('inventory.view',        'Inventory',            'View inventory & issuances'),
  ('inventory.edit',        'Inventory',            'Add / edit inventory'),
  ('documents.view',        'Documents',            'View documents'),
  ('documents.edit',        'Documents',            'Upload / delete documents'),
  ('compliance.view',       'Compliance',           'View important dates & alerts'),
  ('compliance.edit',       'Compliance',           'Add / edit dates & alerts'),
  ('compliance.filings',    'Compliance',           'File / edit statutory filings'),
  ('clients.view',          'Clients & Contracts',  'View clients'),
  ('clients.edit',          'Clients & Contracts',  'Add / edit clients'),
  ('contracts.view',        'Clients & Contracts',  'View contracts'),
  ('contracts.edit',        'Clients & Contracts',  'Add / edit / delete contracts'),
  ('roster.view',           'Daily Reports',        'View daily reports'),
  ('roster.edit',           'Daily Reports',        'Write daily reports'),
  ('incidents.view',        'Daily Reports',        'View incidents'),
  ('incidents.edit',        'Daily Reports',        'Log / edit incidents'),
  ('reports.view',          'Reports & Finance',    'View financial reports & partnership'),
  ('cashflow.view',         'Reports & Finance',    'View cashflow'),
  ('coa.view',              'Reports & Finance',    'View Chart of Accounts & Trial Balance'),
  ('period_close.manage',   'Reports & Finance',    'Close / reopen accounting periods'),
  ('partnership.post',      'Reports & Finance',    'Post / reverse a partnership run'),
  ('settings.view',         'Settings & Users',     'View settings (locations, notifications)'),
  ('settings.edit',         'Settings & Users',     'Edit settings'),
  ('users.manage',          'Settings & Users',     'Create / edit other users'),
  ('audit_log.view',        'Settings & Users',     'View audit log')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

create or replace function public.permission_keys_demanded()
returns table(key text, demanded_by text, kind text)
language sql
stable
set search_path to 'public'
as $function$
  -- Bodies. executable_source() strips comments first, so a key merely
  -- discussed in a comment is not counted as demanded.
  select m[1], p.proname, 'function'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
         lateral regexp_matches(
           public.executable_source(pg_get_functiondef(p.oid)),
           '(?:require_perm|has_perm)\s*\(\s*''([a-zA-Z_]+\.[a-zA-Z_]+)''', 'g') m
   where n.nspname = 'public' and p.prokind = 'f'
  union
  -- Policies. A key demanded only by an RLS predicate is exactly as
  -- ungrantable as one demanded by a function, and is easier to miss.
  select m[1], pol.tablename || ' · ' || pol.policyname, 'policy'
    from pg_policies pol,
         lateral regexp_matches(
           coalesce(pol.qual, '') || ' ' || coalesce(pol.with_check, ''),
           'has_perm\s*\(\s*''([a-zA-Z_]+\.[a-zA-Z_]+)''', 'g') m
   where pol.schemaname = 'public';
$function$;

create or replace function public.permission_key_gaps()
returns table(key text, demanded_by text, kind text)
language sql
stable
set search_path to 'public'
as $function$
  select d.key, d.demanded_by, d.kind
    from public.permission_keys_demanded() d
   where not exists (select 1 from public.permission_keys k where k.key = d.key)
   order by d.key, d.demanded_by;
$function$;

comment on function public.permission_key_gaps() is
  '0384: permission keys the database DEMANDS (require_perm/has_perm in a function body, or has_perm in an RLS policy) that are absent from public.permission_keys, the catalogue mirroring PERMISSION_GROUPS in src/app/lib/supabase.ts. A key here can never be granted to anybody, so the gate it guards is unreachable and the refusal is indistinguishable from a correct denial. Found twice by hand first: partnership.post (0361) and employees.ops_verify (0384). The reverse direction — catalogued but unused — is deliberately NOT reported, because a key may legitimately gate a screen rather than a row.';

-- ---------------------------------------------------------------------------
-- PROVE THE CHECK BITES, using the real historical case, BEFORE closing it.
--
-- The catalogue above deliberately does NOT yet contain employees.ops_verify.
-- So at this point the gap report must name it and nothing else. If it came
-- back empty here, the checker would be inert and the two rows added below
-- would make it look like it worked.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(distinct g.key, ', ') into v_n, v_who
    from public.permission_key_gaps() g;
  if v_who is distinct from 'employees.ops_verify' then
    raise exception
      '0384 FAILED: the gap report says "%" and it should say exactly employees.ops_verify. Either the checker does not read what it claims to, or something else is ungrantable and this migration has not accounted for it.', coalesce(v_who, '(nothing)');
  end if;
  raise notice '0384: the checker bites — it found employees.ops_verify in % place(s).', v_n;
end $$;

-- ---------------------------------------------------------------------------
-- The two keys transition_record_state needs, one per STAGE.
--
-- The rule — require what a direct write to the target table would require —
-- would say employees.edit, because that function writes employees. The rule
-- is set aside here deliberately and the exception is written into CLAUDE.md
-- beside it: WHERE A FUNCTION EXISTS SO THAT TWO DIFFERENT PEOPLE ACT, THE KEY
-- FOLLOWS THE STAGE AND NOT THE TABLE. Flattening ops-verify and
-- finance-approve into employees.edit — held by everyone who can edit staff at
-- all — deletes the separation of duties the two-stage design exists for.
-- ---------------------------------------------------------------------------
insert into public.permission_keys (key, grp, label) values
  ('employees.ops_verify',      'Employees', 'Ops-verify a draft employee record'),
  ('employees.finance_approve', 'Employees', 'Finance-approve an Ops-verified employee record')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

-- ---------------------------------------------------------------------------
-- ledger_checks gains the arm, by surgery against the live definition.
--
-- Restating it is forbidden: it has many authors, and 0286/0288 dropped two
-- checks by restating from a copy while reporting success. The anchor is
-- asserted to appear exactly once before anything is replaced, and the canary
-- count is bumped in the same edit — 0301 bumped one of three copies of that
-- number and the canary then disagreed with itself on every company.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def   text;
  v_new   text;
  v_hits  int;
  v_co    uuid;
  v_before int;
  v_after  int;
  a_arm   text := '      from public.migration_ledger_drift()' || chr(10) || '  )';
  a_cnry  text := '(select 33::numeric n) e (n);   -- expected_check_count';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ledger_checks';
  if v_def is null then raise exception '0384 REFUSED: ledger_checks() does not exist.'; end if;

  if public.executable_source(v_def) ~ 'permission_key_gaps' then
    raise exception '0384 REFUSED: ledger_checks already carries the permission-key arm.';
  end if;

  v_hits := (length(v_def) - length(replace(v_def, a_arm, ''))) / length(a_arm);
  if v_hits <> 1 then
    raise exception '0384 REFUSED: the arm anchor appears % time(s), expected 1.', v_hits;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a_cnry, ''))) / length(a_cnry);
  if v_hits <> 1 then
    raise exception '0384 REFUSED: the canary anchor appears % time(s), expected 1. The count may have moved.', v_hits;
  end if;

  select id into v_co from public.companies order by created_at limit 1;
  select count(*) into v_before from public.ledger_checks(v_co);

  v_new := replace(v_def, a_arm,
    '      from public.migration_ledger_drift()' || chr(10) ||
    '    union all' || chr(10) ||
    '    -- 0384. Does every permission the database demands exist in the' || chr(10) ||
    '    -- catalogue the grant screen renders? A key that does not is one' || chr(10) ||
    '    -- nobody can be given, and its refusal is indistinguishable from a' || chr(10) ||
    '    -- correct denial. Company-independent: it reads the catalogue.' || chr(10) ||
    '    select ''every_demanded_permission_is_grantable''::text,' || chr(10) ||
    '           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0' || chr(10) ||
    '      from public.permission_key_gaps()' || chr(10) ||
    '  )');
  v_new := replace(v_new, a_cnry, '(select 34::numeric n) e (n);   -- expected_check_count');
  execute v_new;

  select count(*) into v_after from public.ledger_checks(v_co);
  if v_after <> v_before + 1 then
    raise exception '0384 FAILED: ledger_checks returned % rows, expected %.', v_after, v_before + 1;
  end if;

  -- The canary must agree, and the new arm must be GREEN — the two keys above
  -- are what makes it so, and a red arm here would mean they did not land.
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'checks_evaluated' and not c.passed) then
    raise exception '0384 FAILED: the canary disagrees with itself after the bump.';
  end if;
  if exists (select 1 from public.ledger_checks(v_co) c
              where c.check_name = 'every_demanded_permission_is_grantable' and not c.passed) then
    raise exception
      '0384 FAILED: the new arm is red. Some permission is still demanded and not catalogued: %',
      (select string_agg(g.key || ' (' || g.demanded_by || ')', ', ') from public.permission_key_gaps() g);
  end if;

  raise notice '0384: ledger_checks now evaluates % checks, and the permission arm is green.', v_after - 1;
end $$;

-- ---------------------------------------------------------------------------
-- The tail required of every migration (scripts/migration-template.sql).
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0384 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
