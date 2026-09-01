-- 0242b — The two functions 0242's own predicate skipped, and an existence
-- oracle found while reading them.
--
-- DEV ONLY.
--
-- HOW THEY WERE MISSED
--
-- 0242 selected its targets with `prosrc not ilike '%current_company_id%'`,
-- treating a mention of current_company_id as evidence of a tenant check. That
-- is the SAME class of mistake as the '%company_id%' filter this whole audit
-- started by correcting — a mention is not a check. It skipped exactly two
-- functions, and 0243's gap check caught both immediately, on its first run,
-- before either had shipped anywhere. That is the check earning its place on
-- day one rather than in six months.
--
-- WHAT READING THEM FOUND
--
-- Both turned out to be genuinely guarded by hand, which is the good news.
-- They are the only two of 140 that were. But:
--
-- 1. record_invoice_payment IS AN EXISTENCE ORACLE.
--
--    It distinguishes the two cases the guard deliberately conflates:
--
--      if v_company is null then raise 'Invoice not found';
--      if v_caller_company is distinct from v_company
--                          then raise 'Not authorised for this company';
--
--    A caller walking uuids learns which invoice ids are REAL — 'Invoice not
--    found' for a fake one, 'Not authorised' for a competitor's. It never
--    returns the invoice, so this reads as safe, and it is not: invoice ids
--    appear in URLs and exports, and confirming which are live is the first
--    step of every enumeration. assert_same_company goes in FIRST, so both
--    cases now answer identically. The old checks stay below it as
--    belt-and-braces; they are simply no longer reachable with a foreign id.
--
-- 2. post_manual_journal never checked p_branch_id.
--
--    It validates that both accounts belong to the caller's company, and then
--    passes p_branch_id straight through to post_journal as the region. A
--    branch id belonging to ANOTHER company would be written onto the caller's
--    own journal entry. That is not a leak — nothing is disclosed — but it
--    writes a foreign key across a tenant boundary into the ledger, and the
--    regional P&L reads region off that column. Guarded conditionally, because
--    p_branch_id is legitimately NULL for an unregioned entry.
--
-- Injected mechanically rather than by retyping the bodies. record_invoice_
-- payment is 110 lines of settlement logic; hand-copying it to add three lines
-- is how you lose a `continue when` clause.

do $gen$
declare
  r       record;
  v_guard text;
  v_body  text;
  v_def   text;
  v_hdr   text;
  v_rest  text;
  p1      int;
  p2      int;
  v_done  int := 0;
begin
  for r in
    select p.oid, p.proname, p.prosrc, m.param, m.tbl
      from pg_proc p
      join (values ('record_invoice_payment', 'p_invoice_id',       'invoices'),
                   ('post_manual_journal',    'p_debit_account_id', 'chart_of_accounts'))
             as m(fn, param, tbl) on m.fn = p.proname::text
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc not ilike '%assert_same_company%'
  loop
    v_guard := format(
      E'  -- tenant guard [resolved]: owning company looked up from %I via public.%I (0242b)\n'
      '  perform public.assert_same_company((select company_id from public.%I where id = %I));' || E'\n',
      r.param, r.tbl, r.tbl, r.param);

    -- post_manual_journal alone also carries a foreign key it never checked.
    if r.proname = 'post_manual_journal' then
      v_guard := v_guard ||
        E'  -- tenant guard [resolved]: p_branch_id is written onto the journal entry\n'
        '  -- and read back as the region. NULL is legitimate (unregioned entry),' || E'\n'
        '  -- so it is checked only when supplied.' || E'\n'
        '  if p_branch_id is not null then' || E'\n'
        '    perform public.assert_same_company((select company_id from public.branches where id = p_branch_id));' || E'\n'
        '  end if;' || E'\n';
    end if;

    p1     := regexp_instr(r.prosrc, '\mbegin\M', 1, 1, 0, 'i');
    v_body := left(r.prosrc, p1 + 4) || E'\n' || v_guard || substr(r.prosrc, p1 + 5);

    v_def  := pg_get_functiondef(r.oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);

    execute v_hdr || '$function$' || v_body || '$function$' || substr(v_rest, p2 + 10);
    v_done := v_done + 1;
  end loop;

  raise notice '0242b guarded % function(s)', v_done;
end
$gen$;

do $verify$
declare
  v_n int;
begin
  select count(*) into v_n
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('record_invoice_payment', 'post_manual_journal')
     and p.prosrc ilike '%assert_same_company%';
  if v_n <> 2 then
    raise exception '0242b guarded % of 2 functions', v_n using errcode = '42501';
  end if;

  -- The branch guard specifically, since it is the one that is not part of the
  -- standard pattern and would be silently dropped by a careless edit.
  if not exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = 'post_manual_journal'
       and p.prosrc like '%where id = p_branch_id%') then
    raise exception '0242b did not add the p_branch_id guard to post_manual_journal'
      using errcode = '42501';
  end if;
end
$verify$;
