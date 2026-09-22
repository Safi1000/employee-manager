-- 0469 — a contract, its sites, its lines and its shift definitions save in ONE
-- transaction: save_contract().
--
-- WHAT WAS WRONG. ContractEditorModal saved in the browser as a chain of
-- independent round trips — every site, then the contract, then the lines, then
-- each site's shift_definitions. Three defects followed, all seen on Bank of AJK
-- on 2026-09-22 (see 0468):
--
--   1. A NEW ACTIVE CONTRACT COULD NEVER GET ITS LINES. 0450's committed-total
--      invariant takes the group's pre-transaction sum as its baseline. For a
--      contract that did not exist a moment ago that baseline is 0, so its
--      original terms read as an amendment ("was 0, now 4") and were refused.
--      Status defaults to Active, so "Add Contract" failed unless the user knew
--      to pick Draft first. The same applied to a Draft edited and switched to
--      Active in one save: the contract row flipped first, the lines were judged
--      against Active.
--   2. NOTHING ROLLED BACK. By the time the lines were refused, the sites and
--      the contract had committed: four orphan Active contracts, and 213
--      duplicate sites because the form never learned the ids of the sites it
--      had just inserted and inserted them again on every retry.
--   3. ONE CONTRACT'S SAVE DELETED ANOTHER'S SHIFTS. The shift_definitions pass
--      walked every site of the CLIENT and dropped any shift this contract had
--      no line for — including a shift another contract staffs at that site.
--
-- Also: a Day/Night rebalance, which 0450 allows because its deferred check
-- judges the net effect at commit, could not pass through the editor at all —
-- each line UPDATE was its own transaction, so the first half of a rebalance was
-- judged alone.
--
-- THE FIX. save_contract() does all of it in one transaction:
--   * Sites resolve by id, or by (client, name) for a new draft — so a re-save
--     reuses the site; 0468's unique index backs this up. Returns key -> id.
--   * The lines of a contract that was not Active BEFORE this call (new, Draft,
--     Expired…) are its original terms: they are written with
--     app.contract_amendment set for the line writes only, then cleared. The
--     lines of a contract that WAS Active go through 0450's triggers untouched,
--     so a changed total is still refused and a rebalance now passes.
--   * The contract columns enforce_contract_lock guards are left as they are on
--     a contract that was Active (they change by addendum); everything else —
--     status, end date, notice, leaves, renewal terms — saves normally.
--   * shift_definitions: a missing shift is added for every site this contract
--     staffs; a shift is dropped only where NO live contract (active or draft)
--     staffs it at that site any more.
--   * A removed site is refused, not cascaded, while anything still points at
--     it. contract_lines.site_id is ON DELETE CASCADE, so an unchecked delete
--     would silently take another contract's lines with it.
--
-- KEY. contracts.edit — what a direct write to contracts, contract_lines, sites
-- and shift_definitions requires (0450's restrictive policies). DEFINER, not
-- invoker: this writes SETS of lines and sites, and under invoker a row RLS hid
-- would be a silently smaller save. The boundary is asserted inside instead:
-- permission, company of client/contract/every site and line id handed in, and
-- the client's branch.

create or replace function public.save_contract(
  p_contract_id      uuid,     -- null = create
  p_client_id        uuid,
  p_contract         jsonb,
  p_use_sites        boolean,
  p_sites            jsonb,    -- [{key, id?, name, location, is_default}]
  p_removed_site_ids uuid[],
  p_lines            jsonb     -- [{id?, site_key, shift_code, category, label, location, committed_count, unit_rate, taxable}]
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_company    uuid;
  v_branch     uuid;
  v_k          public.contracts%rowtype;
  v_was_active boolean := false;
  v_lines_free boolean;
  v_site       jsonb;
  v_line       jsonb;
  v_id         uuid;
  v_site_id    uuid;
  v_name       text;
  v_keymap     jsonb := '{}'::jsonb;
  v_keep_ids   uuid[];
  v_rm         record;
begin
  -- Permission: skipped inside a trigger and for trusted backend (auth.uid()
  -- null), exactly like every other gate here.
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('contracts.edit');
  end if;

  -- Tenant + branch guard. DEFINER bypasses RLS, so every uuid handed in is
  -- asserted; the param name appears literally so tenant_guard_gaps() sees it.
  perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  select c.company_id, c.branch_id into v_company, v_branch from public.clients c where c.id = p_client_id;
  if v_company is null then
    raise exception 'That client no longer exists. Nothing has been saved.' using errcode = 'P0001';
  end if;
  perform public.assert_branch_writable(v_branch);

  if p_contract_id is not null then
    perform public.assert_same_company((select company_id from public.contracts where id = p_contract_id));
    select * into v_k from public.contracts where id = p_contract_id for update;
    if not found then
      raise exception 'That contract no longer exists. Nothing has been saved.' using errcode = 'P0001';
    end if;
    if v_k.client_id <> p_client_id then
      raise exception 'That contract belongs to another client. Nothing has been saved.' using errcode = '42501';
    end if;
    v_was_active := v_k.status = 'active';
  end if;
  v_lines_free := not v_was_active;

  if coalesce(cardinality(p_removed_site_ids), 0) > 0 then
    perform public.assert_same_company(s.company_id)
       from public.sites s where s.id = any (p_removed_site_ids);
    if exists (select 1 from public.sites s
                where s.id = any (p_removed_site_ids) and s.client_id <> p_client_id) then
      raise exception 'A site handed in for removal belongs to another client. Nothing has been saved.'
        using errcode = '42501';
    end if;
  end if;

  -- ── sites ───────────────────────────────────────────────────────────────────
  if p_use_sites then
    for v_site in select * from jsonb_array_elements(coalesce(p_sites, '[]'::jsonb)) loop
      v_name := btrim(coalesce(v_site->>'name', ''));
      continue when v_name = '';
      v_id := nullif(v_site->>'id', '')::uuid;
      if v_id is null then
        -- A new draft whose name the client already has IS that site: reuse it.
        select s.id into v_id from public.sites s
         where s.client_id = p_client_id and lower(btrim(s.name)) = lower(v_name);
      end if;

      if v_id is not null then
        if not exists (select 1 from public.sites s where s.id = v_id and s.client_id = p_client_id) then
          raise exception 'A site on this form belongs to another client. Nothing has been saved.'
            using errcode = '42501';
        end if;
        if exists (select 1 from public.sites s
                    where s.client_id = p_client_id and s.id <> v_id
                      and lower(btrim(s.name)) = lower(v_name)) then
          raise exception 'Two sites cannot both be called "%". Nothing has been saved.', v_name
            using errcode = '23505';
        end if;
        update public.sites
           set name = v_name,
               location = nullif(btrim(coalesce(v_site->>'location', '')), ''),
               is_default = coalesce((v_site->>'is_default')::boolean, false)
         where id = v_id;
      else
        insert into public.sites (company_id, client_id, name, location, is_default)
        values (v_company, p_client_id, v_name,
                nullif(btrim(coalesce(v_site->>'location', '')), ''),
                coalesce((v_site->>'is_default')::boolean, false))
        returning id into v_id;
      end if;
      v_keymap := v_keymap || jsonb_build_object(v_site->>'key', v_id);
    end loop;
  end if;

  -- ── contract ────────────────────────────────────────────────────────────────
  if p_contract_id is null then
    insert into public.contracts (
      company_id, client_id, contract_type, start_date, end_date, is_infinite,
      notice_period_days, number_of_guards, day_guards, night_guards, evening_guards,
      rate_per_guard_per_month, allowed_leaves_per_month, eobi_deduction, eobi_amount,
      annual_escalation_pct, renewal_terms, status, termination_date)
    values (
      v_company, p_client_id,
      p_contract->>'contract_type',
      (p_contract->>'start_date')::date,
      (p_contract->>'end_date')::date,
      coalesce((p_contract->>'is_infinite')::boolean, false),
      (p_contract->>'notice_period_days')::int,
      coalesce((p_contract->>'number_of_guards')::int, 0),
      coalesce((p_contract->>'day_guards')::int, 0),
      coalesce((p_contract->>'night_guards')::int, 0),
      coalesce((p_contract->>'evening_guards')::int, 0),
      coalesce((p_contract->>'rate_per_guard_per_month')::numeric, 0),
      (p_contract->>'allowed_leaves_per_month')::int,
      coalesce((p_contract->>'eobi_deduction')::boolean, false),
      (p_contract->>'eobi_amount')::numeric,
      (p_contract->>'annual_escalation_pct')::numeric,
      p_contract->>'renewal_terms',
      coalesce(p_contract->>'status', 'active')::public.contract_status,
      (p_contract->>'termination_date')::date)
    returning * into v_k;
  else
    -- On a contract that was Active the columns enforce_contract_lock guards
    -- keep their stored value: they move by addendum, not by this form.
    update public.contracts set
      contract_type            = case when v_was_active then contract_type            else p_contract->>'contract_type' end,
      start_date               = case when v_was_active then start_date               else (p_contract->>'start_date')::date end,
      number_of_guards         = case when v_was_active then number_of_guards         else coalesce((p_contract->>'number_of_guards')::int, 0) end,
      day_guards               = case when v_was_active then day_guards               else coalesce((p_contract->>'day_guards')::int, 0) end,
      night_guards             = case when v_was_active then night_guards             else coalesce((p_contract->>'night_guards')::int, 0) end,
      evening_guards           = case when v_was_active then evening_guards           else coalesce((p_contract->>'evening_guards')::int, 0) end,
      rate_per_guard_per_month = case when v_was_active then rate_per_guard_per_month else coalesce((p_contract->>'rate_per_guard_per_month')::numeric, 0) end,
      eobi_amount              = case when v_was_active then eobi_amount              else (p_contract->>'eobi_amount')::numeric end,
      annual_escalation_pct    = case when v_was_active then annual_escalation_pct    else (p_contract->>'annual_escalation_pct')::numeric end,
      eobi_deduction           = case when v_was_active then eobi_deduction           else coalesce((p_contract->>'eobi_deduction')::boolean, false) end,
      end_date                 = (p_contract->>'end_date')::date,
      is_infinite              = coalesce((p_contract->>'is_infinite')::boolean, false),
      notice_period_days       = (p_contract->>'notice_period_days')::int,
      allowed_leaves_per_month = (p_contract->>'allowed_leaves_per_month')::int,
      renewal_terms            = p_contract->>'renewal_terms',
      status                   = coalesce(p_contract->>'status', v_k.status::text)::public.contract_status,
      termination_date         = (p_contract->>'termination_date')::date
    where id = v_k.id
    returning * into v_k;
  end if;

  -- ── lines ───────────────────────────────────────────────────────────────────
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
              where nullif(x->>'id', '') is not null
                and not exists (select 1 from public.contract_lines cl
                                 where cl.id = (x->>'id')::uuid and cl.contract_id = v_k.id)) then
    raise exception 'A line on this form belongs to another contract. Nothing has been saved.'
      using errcode = '42501';
  end if;

  -- Original terms (the contract was not Active before this call) are not an
  -- amendment. The flag covers the line writes only and is cleared after them.
  if v_lines_free then
    perform set_config('app.contract_amendment', '1', true);
  end if;

  select coalesce(array_agg((x->>'id')::uuid), '{}') into v_keep_ids
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) x
   where nullif(x->>'id', '') is not null;

  delete from public.contract_lines
   where contract_id = v_k.id and id <> all (v_keep_ids);

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if p_use_sites and coalesce(v_line->>'site_key', '') <> '' then
      v_site_id := (v_keymap->>(v_line->>'site_key'))::uuid;
      if v_site_id is null then
        raise exception 'A contract line points at a site with no name. Name every site. Nothing has been saved.'
          using errcode = '23514';
      end if;
    else
      v_site_id := null;
    end if;

    if nullif(v_line->>'id', '') is not null then
      update public.contract_lines set
        site_id         = v_site_id,
        shift_code      = nullif(v_line->>'shift_code', '')::public.shift_code,
        category        = (v_line->>'category')::public.contract_line_category,
        label           = v_line->>'label',
        location        = nullif(v_line->>'location', ''),
        committed_count = coalesce((v_line->>'committed_count')::int, 0),
        unit_rate       = coalesce((v_line->>'unit_rate')::numeric, 0),
        taxable         = coalesce((v_line->>'taxable')::boolean, true)
       where id = (v_line->>'id')::uuid and contract_id = v_k.id;
    else
      insert into public.contract_lines (
        company_id, contract_id, site_id, shift_code, category, label, location,
        committed_count, unit_rate, taxable)
      values (
        v_company, v_k.id, v_site_id,
        nullif(v_line->>'shift_code', '')::public.shift_code,
        (v_line->>'category')::public.contract_line_category,
        v_line->>'label',
        nullif(v_line->>'location', ''),
        coalesce((v_line->>'committed_count')::int, 0),
        coalesce((v_line->>'unit_rate')::numeric, 0),
        coalesce((v_line->>'taxable')::boolean, true));
    end if;
  end loop;

  if v_lines_free then
    perform set_config('app.contract_amendment', '', true);
  end if;

  -- ── removed sites ──────────────────────────────────────────────────────────
  -- After the lines, so this contract's own lines there are already gone.
  if p_use_sites and coalesce(cardinality(p_removed_site_ids), 0) > 0 then
    for v_rm in select s.id, s.name from public.sites s where s.id = any (p_removed_site_ids) loop
      if exists (select 1 from public.contract_lines x          where x.site_id = v_rm.id)
      or exists (select 1 from public.deployments x             where x.site_id = v_rm.id)
      or exists (select 1 from public.attendance_records x      where x.site_id = v_rm.id)
      or exists (select 1 from public.attendance_confirmations x where x.site_id = v_rm.id)
      or exists (select 1 from public.vacancies x               where x.site_id = v_rm.id)
      or exists (select 1 from public.kit_events x              where x.site_id = v_rm.id) then
        raise exception 'Site "%" cannot be removed: guards, attendance or another contract still use it. Nothing has been saved.', v_rm.name
          using errcode = '23503';
      end if;
      delete from public.sites where id = v_rm.id;
    end loop;
  end if;

  -- ── shift definitions ───────────────────────────────────────────────────────
  insert into public.shift_definitions (company_id, site_id, shift_code, start_time, end_time, duration_hours, crosses_midnight)
  select distinct v_company, cl.site_id, cl.shift_code::public.shift_code,
         w.start_time, w.end_time, w.duration_hours, w.crosses_midnight
    from public.contract_lines cl
    join (values ('day',     time '08:00', time '20:00', 12::numeric, false),
                 ('evening', time '16:00', time '00:00',  8::numeric, true),
                 ('night',   time '20:00', time '08:00', 12::numeric, true))
         w (code, start_time, end_time, duration_hours, crosses_midnight)
      on w.code = cl.shift_code::text
   where cl.contract_id = v_k.id and cl.site_id is not null
  on conflict (site_id, shift_code) do nothing;

  -- Drop a shift only where no live contract staffs it at that site any more,
  -- and only at sites on this form.
  delete from public.shift_definitions sd
   where sd.site_id in (select (e.value #>> '{}')::uuid from jsonb_each(v_keymap) e)
     and not exists (
       select 1 from public.contract_lines cl
         join public.contracts k on k.id = cl.contract_id
        where cl.site_id = sd.site_id
          and cl.shift_code::text = sd.shift_code::text
          and k.status in ('active', 'draft'));

  return jsonb_build_object(
    'contract_id',   v_k.id,
    'contract_code', v_k.contract_code,
    'site_ids',      v_keymap);
end;
$function$;

revoke all on function public.save_contract(uuid, uuid, jsonb, boolean, jsonb, uuid[], jsonb) from public, anon;
grant execute on function public.save_contract(uuid, uuid, jsonb, boolean, jsonb, uuid[], jsonb) to authenticated;

comment on function public.save_contract(uuid, uuid, jsonb, boolean, jsonb, uuid[], jsonb) is
  '0469: the ONLY writer of a contract with its sites, lines and shift definitions. One transaction; '
  'lines of a contract not Active before the call are original terms (amendment flag, line writes only); '
  'lines of an Active contract pass through 0450''s committed-total and rate locks unchanged.';

-- ── verification ───────────────────────────────────────────────────────────────
-- The failure guarded against is "the new definer writer opens a branch gap",
-- answered by asking branch_guard_gaps() about THIS function, not by a total.
do $mig$
declare v_n int;
begin
  select count(*) into v_n from public.branch_guard_gaps() g where g.function_name = 'save_contract';
  if v_n <> 0 then
    raise exception '0469 FAILED: branch_guard_gaps() lists save_contract % time(s).', v_n;
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0469 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
