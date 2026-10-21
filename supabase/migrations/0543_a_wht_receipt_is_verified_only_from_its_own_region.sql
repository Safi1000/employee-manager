-- 0543 — a WHT receipt is verified only from its own region
--
-- Found 2026-10-22, applying 0542. no_definer_function_crosses_a_branch read
-- 15 on 17 October and 17 now. The two new rows are 0536's own:
-- verify_wht and reject_wht are SECURITY DEFINER, write invoice_payments
-- (which carries branch_scope), and never check the caller's branch. A
-- definer body is not subject to the caller's policies, so a branched user
-- could verify — or mark not deposited, which moves the WHT back onto the
-- client's balance — a receipt from another region that branch_scope would
-- never even show them. Not hypothetical: a Lahore-branched user holds
-- invoices.edit today.
--
-- The change, by surgery (both functions have one author, 0536, but the
-- edit is two lines and an anchor is cheaper to trust than a digest): right
-- after each function reads the receipt, resolve its region exactly as
-- invoice_payments' branch_scope policy does — the receipt's client, else its
-- invoice's client — and assert it is writable by the caller. A receipt with
-- no region at all is invisible to a branched user under that policy, so a
-- branched user is refused it here too; assert_branch_writable alone would
-- let NULL through.
--
-- Not changed: record_payment_withholding, which reject_wht calls, is still
-- on the gaps list in its own right (as are record_invoice_payment and
-- the others named there). The path through reject_wht is now guarded at
-- the parent; the child's direct path is its own case.
--
-- Asserted on the thing that can break: as the real Lahore user, inside a
-- block rolled back by a sentinel, verify_wht and reject_wht on an ISB/RWP
-- receipt are each refused with the branch message — the message, not merely
-- "something raised". And the gap count falls by exactly these two rows.

do $mig$
declare
  v_src text; v_cnt int; v_a text; v_fn text;
  v_guard constant text :=
       E'  -- 0543: the receipt''s region, as invoice_payments'' branch_scope reads it.\n'
    || E'  v_branch := coalesce(\n'
    || E'    (select c.branch_id from public.clients c where c.id = p.client_id),\n'
    || E'    (select c.branch_id from public.invoices i join public.clients c on c.id = i.client_id where i.id = p.invoice_id));\n'
    || E'  if v_branch is null and public.is_branched_user() and not public.is_super_super_admin() then\n'
    || E'    raise exception ''You are assigned to one region and this receipt belongs to none. Nothing has been recorded.'' using errcode = ''42501'';\n'
    || E'  end if;\n'
    || E'  perform public.assert_branch_writable(v_branch);\n';
  v_gaps_before int; v_gaps_after int;
  v_user constant uuid := '581f5ec5-2185-4cb9-8761-1facdb92363e';   -- a Lahore-branched user with invoices.edit
  v_rcpt uuid;
begin
  select count(*) into v_gaps_before from public.branch_guard_gaps() where shape = 'writes';

  foreach v_fn in array array['public.verify_wht(uuid,text,date,text)', 'public.reject_wht(uuid,text)'] loop
    v_src := pg_get_functiondef(v_fn::regprocedure);
    if position('0543' in v_src) = 0 then
      v_a := E'declare p public.invoice_payments; v_n int;\n';
      v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
      if v_cnt <> 1 then raise exception '0543 REFUSED: % declare anchor found % times.', v_fn, v_cnt; end if;
      v_src := replace(v_src, v_a, E'declare p public.invoice_payments; v_n int; v_branch uuid;\n');

      v_a := E'  if p.id is null then raise exception ''That receipt does not exist. Nothing has been recorded.''; end if;\n';
      v_cnt := (length(v_src) - length(replace(v_src, v_a, ''))) / length(v_a);
      if v_cnt <> 1 then raise exception '0543 REFUSED: % receipt anchor found % times.', v_fn, v_cnt; end if;
      v_src := replace(v_src, v_a, v_a || v_guard);
      execute v_src;
    end if;
  end loop;

  -- ── asserts ─────────────────────────────────────────────────────────────────
  select count(*) into v_gaps_after from public.branch_guard_gaps() where shape = 'writes';
  if exists (select 1 from public.branch_guard_gaps() where function_name in ('verify_wht', 'reject_wht')) then
    raise exception '0543 REFUSED: branch_guard_gaps still names verify_wht or reject_wht.';
  end if;
  if v_gaps_before - v_gaps_after <> 2 and v_gaps_before <> v_gaps_after then
    raise exception '0543 REFUSED: branch-guard gaps went from % to %, expected exactly 2 fewer.', v_gaps_before, v_gaps_after;
  end if;

  -- The refusal, as the real Lahore user, on an ISB/RWP receipt.
  select ip.id into v_rcpt
    from public.invoice_payments ip
    left join public.clients c1 on c1.id = ip.client_id
    left join public.invoices i on i.id = ip.invoice_id left join public.clients c2 on c2.id = i.client_id
    join public.branches b on b.id = coalesce(c1.branch_id, c2.branch_id)
   where ip.wht_status = 'claimed' and b.name = 'ISB/RWP'
   order by ip.created_at limit 1;
  if v_rcpt is null or (select branch_id from public.profiles where id = v_user) = (select id from public.branches where name = 'ISB/RWP' limit 1) then
    raise exception '0543 REFUSED: the proof needs a claimed ISB/RWP receipt and a user outside ISB/RWP (receipt %).', v_rcpt;
  end if;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
    begin
      perform public.verify_wht(v_rcpt, '0543-PROOF', current_date, null);
      raise exception '0543 REFUSED: a Lahore user verified an ISB/RWP receipt.';
    exception when others then
      if sqlerrm not like 'You are assigned to one region and this action names another.%' then raise; end if;
    end;
    begin
      perform public.reject_wht(v_rcpt, '0543 proof');
      raise exception '0543 REFUSED: a Lahore user rejected an ISB/RWP receipt.';
    exception when others then
      if sqlerrm not like 'You are assigned to one region and this action names another.%' then raise; end if;
    end;
    raise exception '0543-SENTINEL';
  exception when others then
    if sqlerrm <> '0543-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '', true);
  if (select wht_status from public.invoice_payments where id = v_rcpt) <> 'claimed' then
    raise exception '0543 REFUSED: the proof receipt is no longer claimed.';
  end if;

  raise notice '0543: branch-guard gaps % -> %; Lahore user refused on both.', v_gaps_before, v_gaps_after;
end $mig$;
