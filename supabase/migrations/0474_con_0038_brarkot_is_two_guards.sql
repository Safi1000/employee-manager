-- 0474 — CON-0038 (Bank of AJK): Brarkot is 2 Guards, not 3.
--
-- Follow-up correction to 0472, whose header recorded Brarkot as "already 3;
-- asserted, not written". The client has since confirmed the post is 2 Guards.
-- 0472 is applied and is not edited; the correction lives here.
--
-- Same disposition as 0472: an entry error in the original terms, not a dated
-- commercial change, so it is written under app.contract_amendment with an
-- audit row carrying the reason.
--
-- MEASURED BEFORE (prod): Brarkot line committed 3, with 2 guards posted — the
-- corrected strength still holds both. CON-0038 commits 53; after, 52.
--
-- Authorised by name, 2026-09-22: "Brarkot needs to be 2 guards".

do $mig$
declare
  c_contract constant uuid := 'b0f1157d-6081-426d-bdcd-73b9ae034b7f';
  c_line     constant uuid := '4071d362-5e88-40ad-941e-018dce0e0099';
  v_company  uuid;
  v_now      int;
  v_n        int;
begin
  select l.company_id, l.committed_count into v_company, v_now
    from public.contract_lines l join public.sites s on s.id = l.site_id
   where l.id = c_line and l.contract_id = c_contract and s.name = 'Brarkot';
  if v_company is null then
    raise exception '0474 REFUSED: the Brarkot line of CON-0038 is not where this migration expects it.';
  end if;
  if v_now = 2 then
    raise notice '0474: Brarkot already 2.';
    return;
  end if;
  if v_now <> 3 then
    raise exception '0474 REFUSED: Brarkot commits %, expected 3.', v_now;
  end if;

  perform set_config('app.contract_amendment', '1', true);
  update public.contract_lines set committed_count = 2 where id = c_line;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0474 FAILED: Brarkot line not updated.'; end if;
  update public.contracts set number_of_guards = 52, day_guards = 52, updated_at = now()
   where id = c_contract;
  perform set_config('app.contract_amendment', '0', true);

  insert into public.audit_log (company_id, table_name, record_id, action, changed_by, changes)
  values (v_company, 'contracts', c_contract, 'update', auth.uid(),
          jsonb_build_object('kind', 'contract_amendment', 'field', 'contract_lines',
                             'old', 'Brarkot 3 Guards; 53 committed',
                             'new', 'Brarkot 2 Guards; 52 committed',
                             'reason', 'Correction on the client''s confirmation (0474)'));
end $mig$;

do $mig$
declare c_contract constant uuid := 'b0f1157d-6081-426d-bdcd-73b9ae034b7f'; v int;
begin
  select committed_count into v from public.contract_lines where id = '4071d362-5e88-40ad-941e-018dce0e0099';
  if v <> 2 then raise exception '0474 FAILED: Brarkot commits %, expected 2.', v; end if;
  select coalesce(sum(committed_count), 0) into v from public.contract_lines where contract_id = c_contract;
  if v <> 52 then raise exception '0474 FAILED: CON-0038 commits %, expected 52.', v; end if;
  if (select number_of_guards from public.contracts where id = c_contract) <> 52 then
    raise exception '0474 FAILED: CON-0038 header does not say 52.';
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0474 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
