-- 0472 — CON-0038 (Bank of AJK) is corrected to the strength the client gave.
--
-- A CORRECTION, not an amendment. CON-0038 was entered on 2026-09-22 and its
-- lines were wrong on the day they were entered: two posts carried Senior
-- Supervisor instead of Guard, two branches were listed that the client does
-- not have, and three posts were short by one. None of that is a change in the
-- commercial terms from a date — it is what the contract always said — so it
-- is not a dated addendum. It is written under app.contract_amendment, the same
-- logged-correction path amend_contract() uses, and an audit row records the
-- reason, exactly as amend_contract() does for a header field.
--
-- The client's list (x is the TOTAL strength of the post, not a multiplier):
--   Paniola                — Senior Supervisor -> Guard (1)
--   SAMD Chattar           — Senior Supervisor -> Guard (1)
--   Main Kotli             — remove the location
--   Lari Adda Kotli        — 2 Guards   (was 1)
--   Jura                   — 2 Guards   (was 1)
--   Brarkot                — 3 Guards   (already 3; asserted, not written)
--   Gojra Head Office Ops  — 2 Guards   (was 1)
--   Gojra                  — remove the location
--
-- Committed total: 52 - 1 (Main Kotli) - 1 (Gojra) + 1 + 1 + 1 = 53, all Day.
--
-- MEASURED BEFORE (prod): Main Kotli and Gojra have no posting, attendance,
-- confirmation, vacancy, kit event, employee or addendum against them — only
-- one shift_definition each, which goes with the site. Paniola and SAMD Chattar
-- each have one guard posted (GGS-00598, GGS-00600); a posting is tied to the
-- LINE, not to its category, so both stay posted on the corrected Guard line.
--
-- Authorised by name, 2026-09-22: "do this for bank of AJK".
--
-- ALSO FIXED HERE, because this migration is what found it. 0450's deferred
-- contract_lines_group_sum_invariant reads the session temp table
-- cl_group_sum_baseline, which only contract_lines_capture_group_sum creates —
-- and the capture trigger returns BEFORE creating it when app.contract_amendment
-- is '1'. So a transaction whose every contract_lines write ran under the flag,
-- on a connection that had never captured anything, raised
-- `relation "cl_group_sum_baseline" does not exist` at COMMIT. That is not only
-- this correction: save_contract (0469) writes a NEW contract's lines under the
-- flag, so "Add Contract" as Active failed on any fresh pooled connection. No
-- table means nothing was captured, which the function already treats as
-- "amendment path, nothing to judge" — it now says so before touching the table.
-- Surgery: 0450 is this function's only author; anchor asserted once.

do $mig$
declare
  v_src text; v_cnt int;
  a text :=
'  select base_sum into v_base from cl_group_sum_baseline where txid = txid_current() and ck = v_ck;
';
  r text :=
'  -- 0472: every write in this session ran under the amendment flag, so the
  -- capture trigger never created its table. Nothing captured, nothing to judge.
  if to_regclass(''pg_temp.cl_group_sum_baseline'') is null then return null; end if;
  select base_sum into v_base from cl_group_sum_baseline where txid = txid_current() and ck = v_ck;
';
begin
  v_src := pg_get_functiondef('public.contract_lines_group_sum_invariant()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, a, ''))) / length(a);
  if v_cnt <> 1 then raise exception '0472 REFUSED: group-sum invariant anchor found % times (want 1).', v_cnt; end if;
  execute replace(v_src, a, r);
end $mig$;

do $mig$
declare
  c_contract constant uuid := 'b0f1157d-6081-426d-bdcd-73b9ae034b7f';
  c_client   constant uuid := '9fc431f3-6329-4050-8df2-eac136278716';
  v_company  uuid;
  v_n        int;
  v_sum      int;
  v_gone     uuid[];
  v_site     record;
begin
  select company_id into v_company from public.contracts
   where id = c_contract and contract_code = 'CON-0038' and client_id = c_client;
  if v_company is null then
    raise exception '0472 REFUSED: CON-0038 is not the BAJK contract this migration was written for.';
  end if;

  -- Idempotent: an already-corrected contract is left alone.
  select coalesce(sum(committed_count), 0) into v_sum from public.contract_lines where contract_id = c_contract;
  if v_sum = 53 and not exists (select 1 from public.contract_lines
                                 where contract_id = c_contract and category = 'SR_SUPERVISOR') then
    raise notice '0472: CON-0038 already corrected.';
    return;
  end if;
  if v_sum <> 52 then
    raise exception '0472 REFUSED: CON-0038 commits %, expected 52 — changed since this was written.', v_sum;
  end if;

  perform set_config('app.contract_amendment', '1', true);

  -- 1–2. Senior Supervisor -> Guard.
  update public.contract_lines l set category = 'GUARD', label = 'Guard'
    from public.sites s
   where s.id = l.site_id and l.contract_id = c_contract
     and s.name in ('Paniola', 'SAMD Chattar') and l.category = 'SR_SUPERVISOR';
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception '0472 REFUSED: expected 2 Senior Supervisor lines to correct, found %.', v_n; end if;

  -- 4, 5, 7. Strength 1 -> 2.
  update public.contract_lines l set committed_count = 2
    from public.sites s
   where s.id = l.site_id and l.contract_id = c_contract
     and s.name in ('Lari Adda Kotli', 'Jura', 'Gojra Head Office Ops') and l.committed_count = 1;
  get diagnostics v_n = row_count;
  if v_n <> 3 then raise exception '0472 REFUSED: expected 3 lines at strength 1 to raise, found %.', v_n; end if;

  -- 3, 8. Remove Main Kotli and Gojra — the line, then the site.
  select array_agg(s.id) into v_gone from public.sites s
   where s.client_id = c_client and s.name in ('Main Kotli', 'Gojra');
  if coalesce(cardinality(v_gone), 0) <> 2 then
    raise exception '0472 REFUSED: expected the 2 sites Main Kotli and Gojra, found %.', coalesce(cardinality(v_gone), 0);
  end if;
  for v_site in select id, name from public.sites where id = any (v_gone) loop
    if exists (select 1 from public.deployments where site_id = v_site.id)
    or exists (select 1 from public.attendance_records where site_id = v_site.id)
    or exists (select 1 from public.attendance_confirmations where site_id = v_site.id)
    or exists (select 1 from public.vacancies where site_id = v_site.id)
    or exists (select 1 from public.kit_events where site_id = v_site.id)
    or exists (select 1 from public.contract_lines where site_id = v_site.id and contract_id <> c_contract)
    or exists (select 1 from public.contract_lines l join public.deployments d on d.contract_line_id = l.id where l.site_id = v_site.id)
    or exists (select 1 from public.contract_lines l join public.employees e on e.contract_line_id = l.id where l.site_id = v_site.id)
    or exists (select 1 from public.contract_lines l join public.contract_addendums a on a.contract_line_id = l.id where l.site_id = v_site.id) then
      raise exception '0472 REFUSED: site "%" is now in use and cannot be removed.', v_site.name;
    end if;
  end loop;
  delete from public.contract_lines where contract_id = c_contract and site_id = any (v_gone);
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception '0472 REFUSED: expected 2 lines at the removed sites, found %.', v_n; end if;
  delete from public.shift_definitions where site_id = any (v_gone);
  delete from public.sites where id = any (v_gone);
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception '0472 FAILED: removed % of 2 sites.', v_n; end if;

  -- Header columns the board and legacy readers use, rolled up from the lines.
  update public.contracts set number_of_guards = 53, day_guards = 53, updated_at = now()
   where id = c_contract;

  perform set_config('app.contract_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'contracts', c_contract, 'update', auth.uid(),
          jsonb_build_object('kind', 'contract_amendment', 'field', 'contract_lines',
                             'old', '52 committed; Paniola, SAMD Chattar Senior Supervisor; Main Kotli, Gojra listed',
                             'new', '53 committed, all Guard; Main Kotli, Gojra removed; Lari Adda Kotli, Jura, Gojra Head Office Ops 2',
                             'reason', 'Correction of entry errors on the client''s own list (0472)'));
end $mig$;

-- Verification: each correction asked about directly.
do $mig$
declare
  c_contract constant uuid := 'b0f1157d-6081-426d-bdcd-73b9ae034b7f';
  v int;
begin
  select coalesce(sum(committed_count), 0) into v from public.contract_lines where contract_id = c_contract;
  if v <> 53 then raise exception '0472 FAILED: CON-0038 commits %, expected 53.', v; end if;
  if exists (select 1 from public.contract_lines where contract_id = c_contract and category <> 'GUARD') then
    raise exception '0472 FAILED: a non-Guard line remains on CON-0038.';
  end if;
  select count(*) into v from public.contract_lines l join public.sites s on s.id = l.site_id
   where l.contract_id = c_contract
     and ((s.name in ('Lari Adda Kotli', 'Jura', 'Gojra Head Office Ops') and l.committed_count = 2)
       or (s.name = 'Brarkot' and l.committed_count = 3));
  if v <> 4 then raise exception '0472 FAILED: % of the 4 corrected strengths match.', v; end if;
  if exists (select 1 from public.sites where client_id = '9fc431f3-6329-4050-8df2-eac136278716'
              and name in ('Main Kotli', 'Gojra')) then
    raise exception '0472 FAILED: Main Kotli or Gojra still exists.';
  end if;
  if (select number_of_guards from public.contracts where id = c_contract) <> 53 then
    raise exception '0472 FAILED: CON-0038 header does not say 53.';
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0472 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
