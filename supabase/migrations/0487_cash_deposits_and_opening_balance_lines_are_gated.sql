-- 0487 — cash_deposits and opening_balance_lines: gate the tables (no new RPC).
--
-- cash_deposits: the money + GL already route through record_cash_deposit
-- (accounting.edit, 0411). The only raw write left is the Drive-link patch after
-- the deposit is created, done by the same accounting.edit user, so gating the
-- table on accounting.edit blocks stray raw writes and breaks nothing.
--
-- opening_balance_lines: these are DRAFT lines; the GL moment is post_opening_
-- balances (DEFINER, coa.view). Gate the draft rows on coa.view to match. NOTE:
-- gating a WRITE on a VIEW key is a deliberate compromise — it is consistent with
-- the existing RPC and better than nothing, but a real coa.edit key would be
-- cleaner. Recorded here so a later reader does not mistake it for design intent.

do $mig$
declare spec record;
begin
  for spec in
    select tbl, key from (values
      ('cash_deposits',         'accounting.edit'),
      ('opening_balance_lines', 'coa.view')
    ) as v(tbl, key)
  loop
    execute format($f$
      drop policy if exists perm_write_ins on public.%1$I;
      drop policy if exists perm_write_upd on public.%1$I;
      drop policy if exists perm_write_del on public.%1$I;
      create policy perm_write_ins on public.%1$I as restrictive for insert
        with check ((select public.has_perm(%2$L)));
      create policy perm_write_upd on public.%1$I as restrictive for update
        using ((select public.has_perm(%2$L)))
        with check ((select public.has_perm(%2$L)));
      create policy perm_write_del on public.%1$I as restrictive for delete
        using ((select public.has_perm(%2$L)));
    $f$, spec.tbl, spec.key);
  end loop;
end $mig$;

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit')
   or not exists (select 1 from public.permission_keys where key = 'coa.view') then
    raise exception '0487 FAILED: accounting.edit / coa.view missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname in ('cash_deposits','opening_balance_lines') and p.polname like 'perm_write_%';
  if v_n <> 6 then raise exception '0487 FAILED: expected 6 perm_write policies across the two tables, found %.', v_n; end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0487 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
