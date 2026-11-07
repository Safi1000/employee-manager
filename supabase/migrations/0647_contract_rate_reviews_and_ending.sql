-- 0647 — contract rate reviews (annual and statutory) and ending a contract.
--
-- Shayan, 7 Nov 2026: "a client gives us only 3% instead of the 10% he
-- promised", "a client ends the contract early", "EOBI increased by 70 rs then
-- how to include that". None of these had a place:
--
--   * An increase could only be recorded as a RATE_CHANGE addendum — so a
--     refusal, a deferral, or 3% against a 10% clause left no trace, the
--     reminder kept coming, and nothing showed the shortfall.
--   * A statutory change (EOBI, minimum wage) reaches payroll through
--     statutory_rates, but nothing proposed the matching rate change to each
--     client or tracked who accepted (clause 4: "revised through mutual consent").
--   * Ending a contract set a termination date, nothing more: no notice date,
--     no "who ended it", no notice-period shortfall ("one month notice or
--     equivalent amount").
--
-- 1. contract_rate_reviews — one row per review: kind (annual / statutory /
--    other), when it was due, the basis, what was asked (% or Rs per guard),
--    the outcome (proposed / agreed / partial / refused / deferred), what was
--    agreed, when it takes effect, and the RATE_CHANGE addendums it produced.
-- 2. decide_rate_review — records a decision. agreed / partial writes the rate
--    changes ITSELF: one RATE_CHANGE per contract line at that line's own
--    current rate (a contract with two guard rates, like Nova, is not
--    flattened), plus one site-scoped RATE_CHANGE per site for guards added by
--    addendum without a line (Bank of AJK's branches). Site-scoped rate changes
--    (line null, site set) apply only to addendum-added guards at that site —
--    the screens and the invoice read them that way from 7 Nov 2026.
-- 3. propose_statutory_reviews — e.g. "EOBI +70 per guard from 1 Jan" across
--    the contracts chosen, each left 'proposed' until the client answers.
-- 4. end_contract — termination date, notice served on, ended by, reason;
--    returns the notice shortfall in days and the guards still posted, so the
--    screen can show the notice charge and who must be moved. A last day in the
--    past marks the contract terminated now; a future one stays active (billing
--    already stops at termination_date).
--
-- Writes a SET of addendums behind a permission, so SECURITY DEFINER with the
-- boundary asserted inside (CLAUDE.md: a set operation is not safe as invoker).

-- ── Contracts: how it ended ───────────────────────────────────────────────
alter table public.contracts add column if not exists notice_served_on date;
alter table public.contracts add column if not exists ended_by text;
alter table public.contracts add column if not exists termination_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contracts_ended_by_check') then
    alter table public.contracts add constraint contracts_ended_by_check check (ended_by is null or ended_by in ('client', 'company', 'mutual'));
  end if;
end $$;
comment on column public.contracts.notice_served_on is '0647: the day notice to end the contract was served (by either side).';
comment on column public.contracts.ended_by is '0647: client / company / mutual — who ended the contract.';

-- ── Rate reviews ──────────────────────────────────────────────────────────
create table if not exists public.contract_rate_reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  kind text not null check (kind in ('annual', 'statutory', 'other')),
  due_on date not null,
  basis text,
  requested_pct numeric,
  requested_amount numeric,
  outcome text not null default 'proposed' check (outcome in ('proposed', 'agreed', 'partial', 'refused', 'deferred')),
  agreed_pct numeric,
  agreed_amount numeric,
  effective_from date,
  decided_on date,
  note text,
  reference text,
  addendum_ids uuid[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (agreed_pct is null or agreed_amount is null)
);
create index if not exists idx_rate_reviews_contract on public.contract_rate_reviews (contract_id, due_on);
comment on table public.contract_rate_reviews is
  '0647: every contract rate review — annual increase or statutory pass-through — with what was asked, what was agreed (or refused / deferred) and the RATE_CHANGE addendums it produced. Written only by decide_rate_review / propose_statutory_reviews.';
alter table public.contract_rate_reviews enable row level security;
drop policy if exists rate_reviews_read on public.contract_rate_reviews;
create policy rate_reviews_read on public.contract_rate_reviews for select
  using (company_id = (select public.current_company_id()) or (select public.is_ssa_unscoped()));
-- Money-shaped (amounts asked and agreed), so read-gated like the other money tables:
-- only a login that may see contracts may see their rate reviews.
drop policy if exists perm_read on public.contract_rate_reviews;
create policy perm_read on public.contract_rate_reviews as restrictive for select
  using ((select public.has_perm('contracts.view')) or (select public.has_perm('contracts.edit')));
revoke insert, update, delete on public.contract_rate_reviews from anon, authenticated;
grant select on public.contract_rate_reviews to authenticated;

-- ── decide_rate_review ────────────────────────────────────────────────────
create or replace function public.decide_rate_review(
  p_review_id uuid,
  p_contract_id uuid,
  p_kind text,
  p_due_on date,
  p_basis text,
  p_requested_pct numeric,
  p_requested_amount numeric,
  p_outcome text,
  p_agreed_pct numeric,
  p_agreed_amount numeric,
  p_effective_from date,
  p_note text,
  p_reference text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.contract_rate_reviews;
  k public.contracts;
  v_id uuid;
  v_ids uuid[] := '{}';
  v_add uuid;
  l record;
  p record;
  v_rate numeric;
  v_new numeric;
begin
  perform public.require_perm('contracts.edit');
  -- tenant guard [resolved], before anything that could tell a caller whether another company's row exists
  if p_review_id is not null then
    perform public.assert_same_company((select company_id from public.contract_rate_reviews where id = p_review_id));
  else
    perform public.assert_same_company((select company_id from public.contracts where id = p_contract_id));
  end if;
  if p_review_id is not null then
    select * into r from public.contract_rate_reviews where id = p_review_id;
    if r.id is null then raise exception 'That review does not exist.'; end if;
    if r.outcome <> 'proposed' then raise exception 'That review is already decided (%). Record a new one instead.', r.outcome; end if;
    select * into k from public.contracts where id = r.contract_id;
  else
    select * into k from public.contracts where id = p_contract_id;
  end if;
  if k.id is null then raise exception 'That contract does not exist.'; end if;
  -- tenant guard [resolved]: owning company from the contract row
  perform public.assert_same_company(k.company_id);
  perform public.assert_branch_writable((select c.branch_id from public.clients c where c.id = k.client_id));

  if p_outcome not in ('proposed', 'agreed', 'partial', 'refused', 'deferred') then raise exception 'Choose agreed, partial, refused or deferred.'; end if;
  if coalesce(p_kind, r.kind) not in ('annual', 'statutory', 'other') then raise exception 'A review is annual, statutory or other.'; end if;
  if p_outcome in ('agreed', 'partial') then
    if (p_agreed_pct is null) = (p_agreed_amount is null) then raise exception 'Give the agreed increase as a percentage OR as rupees per guard — one of the two.'; end if;
    if coalesce(p_agreed_pct, 1) <= -100 or coalesce(p_agreed_pct, 0) > 100 then raise exception 'An increase of % percent is not plausible.', p_agreed_pct; end if;
    if p_effective_from is null then raise exception 'Give the date the new rate takes effect.'; end if;

    -- One RATE_CHANGE per line, at that line's OWN current rate (latest rate change on/before the date).
    for l in select cl.* from public.contract_lines cl where cl.contract_id = k.id loop
      select coalesce((select a.new_rate from public.contract_addendums a
                        where a.contract_id = k.id and a.change_type = 'RATE_CHANGE' and a.new_rate is not null and a.effective_from <= p_effective_from
                          and (a.contract_line_id = l.id or (a.contract_line_id is null and a.site_id is null and a.category = l.category))
                        order by a.effective_from desc, a.created_at desc limit 1), l.unit_rate) into v_rate;
      v_new := round(case when p_agreed_pct is not null then v_rate * (1 + p_agreed_pct / 100) else v_rate + p_agreed_amount end);
      if v_new = v_rate then continue; end if;
      insert into public.contract_addendums (company_id, contract_id, contract_line_id, category, change_type, count_delta, new_rate,
                                             new_is_infinite, effective_from, source, reference, notes)
      values (k.company_id, k.id, l.id, null, 'RATE_CHANGE', 0, v_new, false, p_effective_from, 'SIGNED_CONTRACT',
              coalesce(nullif(btrim(p_reference), ''), initcap(coalesce(p_kind, r.kind)) || ' rate review'),
              format('%s → %s (%s)', v_rate, v_new, coalesce(p_agreed_pct::text || '%', '+' || p_agreed_amount::text || ' per guard')))
      returning id into v_add;
      v_ids := v_ids || v_add;
    end loop;

    -- Guards added by addendum without a line: one site-scoped RATE_CHANGE per site and category.
    for p in select distinct a.site_id, a.category from public.contract_addendums a
              where a.contract_id = k.id and a.change_type = 'ADD_HEADCOUNT' and a.contract_line_id is null and a.effective_from <= p_effective_from loop
      if p.site_id is null then
        raise exception 'Guards were added to this contract by an addendum with no site — give that addendum a site before recording a rate review.';
      end if;
      select coalesce(
        (select a.new_rate from public.contract_addendums a where a.contract_id = k.id and a.change_type = 'RATE_CHANGE' and a.contract_line_id is null
            and a.site_id = p.site_id and a.category = p.category and a.effective_from <= p_effective_from order by a.effective_from desc, a.created_at desc limit 1),
        (select a.unit_rate from public.contract_addendums a where a.contract_id = k.id and a.change_type = 'ADD_HEADCOUNT' and a.contract_line_id is null
            and a.site_id = p.site_id and a.category = p.category order by a.effective_from desc limit 1)) into v_rate;
      if v_rate is null then continue; end if;
      v_new := round(case when p_agreed_pct is not null then v_rate * (1 + p_agreed_pct / 100) else v_rate + p_agreed_amount end);
      if v_new = v_rate then continue; end if;
      insert into public.contract_addendums (company_id, contract_id, contract_line_id, category, site_id, change_type, count_delta, new_rate,
                                             new_is_infinite, effective_from, source, reference, notes)
      values (k.company_id, k.id, null, p.category, p.site_id, 'RATE_CHANGE', 0, v_new, false, p_effective_from, 'SIGNED_CONTRACT',
              coalesce(nullif(btrim(p_reference), ''), initcap(coalesce(p_kind, r.kind)) || ' rate review'),
              format('Added guards at this site: %s → %s', v_rate, v_new))
      returning id into v_add;
      v_ids := v_ids || v_add;
    end loop;
  end if;

  if p_review_id is not null then
    update public.contract_rate_reviews
       set outcome = p_outcome, agreed_pct = p_agreed_pct, agreed_amount = p_agreed_amount, effective_from = p_effective_from,
           decided_on = case when p_outcome = 'proposed' then null else current_date end,
           note = coalesce(nullif(btrim(p_note), ''), note), reference = coalesce(nullif(btrim(p_reference), ''), reference),
           addendum_ids = addendum_ids || v_ids, updated_at = now()
     where id = p_review_id and outcome = 'proposed';
    v_id := p_review_id;
  else
    if p_due_on is null then raise exception 'Give the date the review was due (the anniversary, or the statutory change''s date).'; end if;
    insert into public.contract_rate_reviews (company_id, contract_id, kind, due_on, basis, requested_pct, requested_amount, outcome,
                                              agreed_pct, agreed_amount, effective_from, decided_on, note, reference, addendum_ids)
    values (k.company_id, k.id, p_kind, p_due_on, nullif(btrim(p_basis), ''), p_requested_pct, p_requested_amount, p_outcome,
            p_agreed_pct, p_agreed_amount, p_effective_from, case when p_outcome = 'proposed' then null else current_date end,
            nullif(btrim(p_note), ''), nullif(btrim(p_reference), ''), v_ids)
    returning id into v_id;
  end if;
  return v_id;
end $$;
comment on function public.decide_rate_review(uuid, uuid, text, date, text, numeric, numeric, text, numeric, numeric, date, text, text) is
  '0647: record an annual / statutory rate review decision; agreed / partial writes one RATE_CHANGE per line at its own rate plus one per site for addendum-added guards. contracts.edit; company and region asserted. A set write behind a permission, so DEFINER.';
revoke all on function public.decide_rate_review(uuid, uuid, text, date, text, numeric, numeric, text, numeric, numeric, date, text, text) from public, anon;
grant execute on function public.decide_rate_review(uuid, uuid, text, date, text, numeric, numeric, text, numeric, numeric, date, text, text) to authenticated;

-- ── propose_statutory_reviews ─────────────────────────────────────────────
create or replace function public.propose_statutory_reviews(
  p_contract_ids uuid[],
  p_amount numeric,
  p_effective_from date,
  p_basis text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare k public.contracts; v_n int := 0;
begin
  perform public.require_perm('contracts.edit');
  if p_amount is null or p_amount = 0 then raise exception 'Give the change per guard in rupees (e.g. 70).'; end if;
  if p_effective_from is null then raise exception 'Give the date the statutory change takes effect.'; end if;
  if nullif(btrim(p_basis), '') is null then raise exception 'Say what changed (e.g. "EOBI employer share +70 from 1 Jan 2027").'; end if;
  for k in select * from public.contracts where id = any(p_contract_ids) loop
    -- tenant guard [resolved]: owning company from each contract row
    perform public.assert_same_company(k.company_id);
    perform public.assert_branch_writable((select c.branch_id from public.clients c where c.id = k.client_id));
    if exists (select 1 from public.contract_rate_reviews r where r.contract_id = k.id and r.kind = 'statutory' and r.due_on = p_effective_from and r.basis = btrim(p_basis)) then continue; end if;
    insert into public.contract_rate_reviews (company_id, contract_id, kind, due_on, basis, requested_amount, outcome)
    values (k.company_id, k.id, 'statutory', p_effective_from, btrim(p_basis), p_amount, 'proposed');
    v_n := v_n + 1;
  end loop;
  if v_n = 0 and coalesce(array_length(p_contract_ids, 1), 0) > 0 and not exists (select 1 from public.contracts where id = any(p_contract_ids)) then
    raise exception 'None of those contracts exist.';
  end if;
  return v_n;
end $$;
comment on function public.propose_statutory_reviews(uuid[], numeric, date, text) is
  '0647: open a statutory pass-through review (Rs per guard from a date) on each contract given; skipped where the same one is already open. contracts.edit; company and region asserted per contract.';
revoke all on function public.propose_statutory_reviews(uuid[], numeric, date, text) from public, anon;
grant execute on function public.propose_statutory_reviews(uuid[], numeric, date, text) to authenticated;

-- ── end_contract ──────────────────────────────────────────────────────────
create or replace function public.end_contract(
  p_contract_id uuid,
  p_last_day date,
  p_notice_served_on date,
  p_ended_by text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare k public.contracts; v_notice int; v_given int; v_short int; v_posted int; v_n int;
begin
  perform public.require_perm('contracts.edit');
  perform public.assert_same_company((select company_id from public.contracts where id = p_contract_id));
  select * into k from public.contracts where id = p_contract_id;
  if k.id is null then raise exception 'That contract does not exist.'; end if;
  -- tenant guard [resolved]: owning company from the contract row
  perform public.assert_same_company(k.company_id);
  perform public.assert_branch_writable((select c.branch_id from public.clients c where c.id = k.client_id));
  if k.status in ('terminated', 'expired') then raise exception 'This contract has already ended (%).', k.status; end if;
  if p_last_day is null then raise exception 'Give the last day the contract runs.'; end if;
  if p_last_day < k.start_date then raise exception 'The last day is before the contract started.'; end if;
  if p_ended_by not in ('client', 'company', 'mutual') then raise exception 'Say who ended it: client, company or mutual.'; end if;
  if p_notice_served_on is not null and p_notice_served_on > p_last_day then raise exception 'Notice cannot be served after the last day.'; end if;

  v_notice := coalesce(k.notice_period_days, 30);
  v_given := case when p_notice_served_on is null then 0 else (p_last_day - p_notice_served_on) end;
  v_short := case when p_ended_by = 'mutual' then 0 else greatest(0, v_notice - v_given) end;

  update public.contracts
     set termination_date = p_last_day, notice_served_on = p_notice_served_on, ended_by = p_ended_by,
         termination_reason = nullif(btrim(p_reason), ''),
         status = case when p_last_day < current_date then 'terminated'::public.contract_status else status end,
         updated_at = now()
   where id = k.id and status not in ('terminated', 'expired');
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The contract could not be updated.'; end if;

  select count(*) into v_posted from public.employees e where e.contract_id = k.id and e.lifecycle_state = 'active';
  return jsonb_build_object('notice_days', v_notice, 'notice_given_days', v_given, 'shortfall_days', v_short,
                            'ended_by', p_ended_by, 'guards_still_posted', v_posted, 'terminated_now', p_last_day < current_date);
end $$;
comment on function public.end_contract(uuid, date, date, text, text) is
  '0647: end a contract — last day, notice served on, who ended it, reason; returns the notice shortfall (days short of notice_period_days, 0 when mutual) and the guards still posted. contracts.edit; company and region asserted.';
revoke all on function public.end_contract(uuid, date, date, text, text) from public, anon;
grant execute on function public.end_contract(uuid, date, date, text, text) to authenticated;

-- ───────────────────────── Tests (rolled back) ─────────────────────────
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_k uuid; v_line uuid; v_rate numeric; v_rev uuid; v_n int; v_res jsonb; v_msg text; v_ran int := 0;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    -- Lexus Tower (CON-0001): 10% clause, anniversary 11 Dec.
    select id into v_k from public.contracts where contract_code = 'CON-0001';
    select id, unit_rate into v_line, v_rate from public.contract_lines where contract_id = v_k order by created_at limit 1;

    -- 1. The client agrees only 3% against a 10% clause: a partial review writes the line's rate change at 3%.
    v_rev := public.decide_rate_review(null, v_k, 'annual', '2026-12-11', 'Annual increase per contract (10%)', 10, null,
                                       'partial', 3, null, '2026-12-11', 'Client agreed 3% only', 'Letter 7 Nov');
    if not exists (select 1 from public.contract_addendums a where a.contract_line_id = v_line and a.change_type = 'RATE_CHANGE'
                    and a.effective_from = '2026-12-11' and a.new_rate = round(v_rate * 1.03)) then
      raise exception '0647 REFUSED: a 3%% partial review did not write the line''s rate change at %.', round(v_rate * 1.03);
    end if;
    if (select outcome from public.contract_rate_reviews where id = v_rev) <> 'partial' then raise exception '0647 REFUSED: the review is not recorded as partial.'; end if;
    v_ran := v_ran + 1;

    -- 2. A refusal is recorded and writes no rate change.
    select count(*) into v_n from public.contract_addendums where contract_id = v_k;
    perform public.decide_rate_review(null, v_k, 'annual', '2027-12-11', null, 10, null, 'refused', null, null, null, 'Client refused', null);
    if (select count(*) from public.contract_addendums where contract_id = v_k) <> v_n then raise exception '0647 REFUSED: a refused review wrote an addendum.'; end if;
    v_ran := v_ran + 1;

    -- 3. Both a % and an amount is refused, in its own words.
    v_msg := null;
    begin perform public.decide_rate_review(null, v_k, 'annual', '2026-12-11', null, null, null, 'agreed', 5, 100, '2026-12-11', null, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Give the agreed increase as a percentage OR as rupees per guard — one of the two.' then raise exception '0647 REFUSED: %% and amount together were not refused (%).', coalesce(v_msg, 'no error'); end if;
    v_ran := v_ran + 1;

    -- 4. Statutory: EOBI +70 proposed on Bank of AJK, then agreed — the added branches get a site-scoped change too.
    select id into v_k from public.contracts where contract_code = 'CON-0038';
    if public.propose_statutory_reviews(array[v_k], 70, '2027-01-01', 'EOBI +70 per guard (test)') <> 1 then raise exception '0647 REFUSED: the statutory review was not opened.'; end if;
    select id into v_rev from public.contract_rate_reviews where contract_id = v_k and kind = 'statutory' and outcome = 'proposed';
    perform public.decide_rate_review(v_rev, null, null, null, null, null, null, 'agreed', null, 70, '2027-01-01', null, 'EOBI letter');
    if not exists (select 1 from public.contract_addendums a where a.contract_id = v_k and a.change_type = 'RATE_CHANGE' and a.contract_line_id is null
                    and a.site_id is not null and a.new_rate = 53151 + 70 and a.effective_from = '2027-01-01') then
      raise exception '0647 REFUSED: guards added by addendum got no site-scoped rate change.';
    end if;
    if (select count(*) from public.contract_addendums a where a.contract_id = v_k and a.change_type = 'RATE_CHANGE' and a.contract_line_id is not null
         and a.effective_from = '2027-01-01') <> (select count(*) from public.contract_lines where contract_id = v_k) then
      raise exception '0647 REFUSED: not every Bank of AJK line got its rate change.';
    end if;
    v_ran := v_ran + 1;

    -- 5. A client ends early with 10 days' notice on a 30-day clause: shortfall 20, still active until the future last day.
    select id into v_k from public.contracts where contract_code = 'CON-0013';
    v_res := public.end_contract(v_k, current_date + 10, current_date, 'client', 'Client closing the site (test)');
    if (v_res->>'shortfall_days')::int <> greatest(0, coalesce((select notice_period_days from public.contracts where id = v_k), 30) - 10) then
      raise exception '0647 REFUSED: shortfall reads % for 10 days'' notice.', v_res->>'shortfall_days';
    end if;
    if (select status from public.contracts where id = v_k) <> 'active' then raise exception '0647 REFUSED: a contract ending in the future was marked ended now.'; end if;
    v_ran := v_ran + 1;

    perform set_config('request.jwt.claims', '{}', true);
    if v_ran <> 5 then raise exception '0647 REFUSED: % of 5 assertions ran.', v_ran; end if;
    raise exception '0647-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0647-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0647 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0647 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name in ('decide_rate_review', 'propose_statutory_reviews', 'end_contract')) then
    raise exception '0647 REFUSED: branch_guard_gaps() reports one of the new functions.';
  end if;
end $test$;