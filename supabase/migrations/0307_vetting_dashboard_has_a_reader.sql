-- 0307 — record the reader vetting_dashboard now has.
--
-- DEV ONLY. Production gets this with the ledger deployment.
--
-- Compliance.tsx reads public.vetting_dashboard as of this commit: a
-- four-number coverage band above the raised alerts, showing cleared against
-- total for police verification, NADRA, CNIC number and CNIC expiry.
--
-- That is the wiring. uninvoked_controls() cannot see src/, so — exactly as
-- 0294 designed it — the view moves into the map that NAMES the reading file
-- rather than into a bare exempt list. The entry is a claim someone can check
-- with one grep, which is the only thing that keeps this map from becoming the
-- silencing mechanism CLAUDE.md warns about for migration-aliases.txt.
--
-- WHY A BAND AND NOT AN ALERT
--
-- Coverage is true of nearly every guard today. Raising it per employee would
-- be 758 warnings that train their reader to ignore the channel — 9.11, and
-- the reason 0297 split vetting failure from vetting gap. One band, four
-- numbers, and it goes quiet on its own as the upload lands.
--
-- The band states the inversion above the numbers rather than inside them:
-- zero adverse results is not zero failures, it is no result recorded either
-- way.

do $map$
declare
  v_oid oid; v_src text; v_new text; v_def text; v_hdr text; v_rest text;
  p1 int; p2 int;
begin
  select p.oid, p.prosrc into v_oid, v_src
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'uninvoked_controls';

  if v_src ~ 'vetting_dashboard' then
    raise notice '0307: vetting_dashboard is already in the map, nothing to do';
    return;
  end if;

  if strpos(v_src, E'      (''warning_alerts'',                   ''src/app/pages/super-admin/Alerts.tsx'')\n') = 0 then
    raise exception '0307 FAILED: the last row of the view_exempt map is not where it was — do not guess';
  end if;

  v_new := replace(v_src,
    E'      (''warning_alerts'',                   ''src/app/pages/super-admin/Alerts.tsx'')\n',
    E'      (''vetting_dashboard'',                ''src/app/pages/super-admin/Compliance.tsx (0306)''),\n'
    || E'      (''warning_alerts'',                   ''src/app/pages/super-admin/Alerts.tsx'')\n');

  if v_new = v_src then
    raise exception '0307 FAILED: substitution changed nothing';
  end if;

  v_def  := pg_get_functiondef(v_oid);
  p1     := strpos(v_def, '$function$');
  v_rest := substr(v_def, p1 + 10);
  p2     := strpos(v_rest, '$function$');
  v_hdr  := left(v_def, p1 - 1);

  execute v_hdr || '$function$' || v_new || '$function$' || substr(v_rest, p2 + 10);
end
$map$;

do $verify$
declare
  v_outcome text;
begin
  begin
    declare
      v_total int; v_bad int; v_cols int;
    begin
      -- 1. THE VIEW STILL EXISTS AND STILL HAS THE COLUMNS THE PAGE SELECTS.
      -- The map records a claim about a file this database cannot read; the
      -- half it CAN check is that the object named still exists in the shape
      -- the named file asks for. A map entry pointing at a dropped view is
      -- the failure this whole mechanism was built to avoid.
      select count(*) into v_cols
        from information_schema.columns
       where table_schema = 'public' and table_name = 'vetting_dashboard'
         and column_name in ('region_name', 'total', 'police_cleared', 'police_pending',
                             'police_adverse', 'police_not_recorded', 'nadra_cleared',
                             'cnic_number_recorded', 'cnic_expiry_recorded');
      if v_cols <> 9 then
        raise exception '0307 FAILED: vetting_dashboard exposes % of the 9 columns Compliance.tsx selects', v_cols;
      end if;

      -- 2. IT IS NO LONGER REPORTED UNINVOKED.
      select count(*) into v_bad from public.uninvoked_controls() u
       where u.object_name = 'vetting_dashboard';
      if v_bad <> 0 then
        raise exception '0307 FAILED: vetting_dashboard is still reported uninvoked';
      end if;

      -- 3. AND NOTHING ELSE MOVED. A map edit that widened a pattern would
      -- clear rows it was never meant to touch, and the count is the cheapest
      -- way to notice. 12 before this migration, 11 after.
      select count(*) into v_total from public.uninvoked_controls();
      if v_total <> 11 then
        raise exception '0307 FAILED: uninvoked_controls reports %, expected 11 — the map edit moved more than one row', v_total;
      end if;

      -- 4. THE MAP STILL REFUSES A VIEW THAT NOTHING READS. Without this, an
      -- edit that emptied the view arm entirely would satisfy 2 and 3 and
      -- leave the check reporting nothing forever.
      if not exists (select 1 from public.uninvoked_controls() u where u.kind = 'view') then
        raise exception '0307 FAILED: the view arm now reports nothing at all — it has stopped looking';
      end if;

      raise exception 'TESTS_OK';
    end;
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome is distinct from 'TESTS_OK' then
    raise exception '0307 verification failed: %', v_outcome;
  end if;
end
$verify$;
