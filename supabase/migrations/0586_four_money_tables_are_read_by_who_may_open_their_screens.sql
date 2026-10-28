-- 0586 — four money tables are read by whoever may open their screens
--
-- Phase 0, Migration C1 (table reads). Shayan, 28 Oct 2026: "sure". Follows
-- 0584 (writes) and 0585 (report functions).
--
-- Reads on these tables were company-wide for any session (company_members,
-- 0424's DEFERRED note). Each now carries a RESTRICTIVE perm_read policy
-- naming the keys of the screens that read it — the shape 0531 gave
-- bank_accounts and invoices:
--
--   bank_transactions        banks.view, accounting.edit, reports.view,
--                            cashflow.view, accountant.view, reversals.execute
--                            (= BANK_READ_KEYS in src/app/lib/bankOptions.ts)
--   partner_account_entries  the same, plus the partnership route's
--                            receivables.view / payables.view and partnership.post
--                            (a partner login stays held to its own rows by 0314's partner_scope)
--   payroll_runs             payroll.view / edit / approve / adjust, reports.view,
--                            accountant.view, period_close.manage, reversals.execute
--   profit_allocation_runs   the partnership route's keys, partnership.post,
--                            reports.view, accountant.view (partner logins already
--                            excluded by not_partner_scoped)
--
-- Who reads them as the user, checked before writing this: screens (listed
-- above by key); reversible_actions (invoker, the Reversals screen —
-- reversals.execute is in both lists); payroll_run_totals (invoker view, no
-- screen); journal_on_partner_entry names partner_account_entries only as a
-- string. SECURITY DEFINER functions read as the owner and are unaffected.
--
-- The shared custodian-balance helper (src/app/lib/custodian.ts) folded these
-- tables into a cash-held figure in the browser. Three screens asked for it
-- regardless of the user's keys — My Profile, the partner detail modal and
-- Accounting. Under this migration a user without banking access would get a
-- SMALLER figure that looks right. The release with this migration asks for
-- balances only with canReadBankBalances(), and My Profile shows no figure
-- without it. DEFERRED: a custodian's own cash held, read through a
-- self-scoped function, so a custodian without banking access still sees his.
--
-- LEFT OPEN, AND SAID SO ON THE OBJECT:
--   chart_of_accounts — DECIDED: names and codes, no figures (balances live in
--     journal_lines, gated by 0531). Nine invoker views read it as the user,
--     trial_balance among them; gating it would blank them for no gain.
--   partners — DEFERRED: names are needed by pickers on screens with no
--     banking access (fuel cards, cash custody, users); the sensitive part is
--     profit_share_percent and the opening columns. The change, if decided:
--     a column-level split or a names-only picker function, then perm_read.
--
-- Asserted: each policy exists once and names only keys public.permission_keys
-- holds; as the HR login (no banking, payroll or partnership key) each table
-- reads zero rows while holding rows; as Shayan each reads every row.
-- payroll_runs is empty on prod, so only its policy is asserted.

do $pol$
declare
  t record;
begin
  for t in select * from (values
    ('bank_transactions',       array['banks.view','accounting.edit','reports.view','cashflow.view','accountant.view','reversals.execute']),
    ('partner_account_entries', array['banks.view','accounting.edit','reports.view','cashflow.view','accountant.view','reversals.execute',
                                      'receivables.view','payables.view','partnership.post']),
    ('payroll_runs',            array['payroll.view','payroll.edit','payroll.approve','payroll.adjust','reports.view','accountant.view',
                                      'period_close.manage','reversals.execute']),
    ('profit_allocation_runs',  array['banks.view','receivables.view','payables.view','accounting.edit','partnership.post',
                                      'reports.view','accountant.view'])
  ) as x(tbl, keys)
  loop
    execute format('drop policy if exists perm_read on public.%I', t.tbl);
    execute format('create policy perm_read on public.%I as restrictive for select to public using (%s)', t.tbl,
      (select string_agg(format('(select public.has_perm(%L))', k), ' or ') from unnest(t.keys) k));
  end loop;
end $pol$;

comment on table public.chart_of_accounts is
  'DECIDED 0586: read company-wide — account names and codes, no figures (balances are journal_lines, gated by 0531). '
  'Nine invoker views (trial_balance among them) read it as the user.';
comment on table public.partners is
  'DEFERRED 0586: read company-wide because pickers on screens without banking access need the names. profit_share_percent and the opening '
  'columns are therefore readable by any login. The change, if decided: a column-level split or a names-only picker function, then perm_read.';

do $test$
declare
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';   -- HR: no banking, payroll or partnership key
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';   -- Shayan Ahmed (super_admin)
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  t text; v_all bigint; v_hr_n bigint; v_boss_n bigint; v_bad text;
begin
  select string_agg(distinct k, ', ') into v_bad
    from pg_policies p, regexp_matches(p.qual, 'has_perm\(''([a-z_.]+)''', 'g') m(a), unnest(m.a) k
   where p.schemaname = 'public' and p.policyname = 'perm_read'
     and p.tablename in ('bank_transactions','partner_account_entries','payroll_runs','profit_allocation_runs')
     and not exists (select 1 from public.permission_keys pk where pk.key = k);
  if v_bad is not null then raise exception '0586 REFUSED: keys the grant screen cannot offer: %', v_bad; end if;

  foreach t in array array['bank_transactions','partner_account_entries','payroll_runs','profit_allocation_runs'] loop
    if (select count(*) from pg_policies where schemaname = 'public' and tablename = t and policyname = 'perm_read' and permissive = 'RESTRICTIVE') <> 1 then
      raise exception '0586 REFUSED: % has no single restrictive perm_read.', t;
    end if;
    execute format('select count(*) from public.%I where company_id = %L', t, v_co) into v_all;
    -- payroll_runs holds no rows on prod (payroll lives in payslips); its policy
    -- is asserted above and the row test below cannot bite on it.
    if v_all = 0 and t <> 'payroll_runs' then raise exception '0586 REFUSED: % holds no rows to test against.', t; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t) into v_hr_n;
    execute 'reset role';

    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute format('select count(*) from public.%I', t) into v_boss_n;
    execute 'reset role';

    if v_hr_n <> 0 then raise exception '0586 REFUSED: the HR login reads % rows of %.', v_hr_n, t; end if;
    if v_boss_n <> v_all then raise exception '0586 REFUSED: Shayan reads % of % rows of %.', v_boss_n, v_all, t; end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $test$;
