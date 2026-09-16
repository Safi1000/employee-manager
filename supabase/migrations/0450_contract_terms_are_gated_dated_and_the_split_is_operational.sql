-- 0450 — contract commercial terms are permission-gated and dated; the day/night
-- split is an operational RPC.
--
-- Part A of the audit found the whole authorisation surface leaks: 105 of 143
-- writable tables have no server-side permission gate. This pass closes the
-- contract commercial-terms family and makes the split an operational action.
--
-- 1) RLS. contract_lines, contract_addendums, sites, shift_definitions gained no
--    permission gate — any company member could rewrite committed_count, unit_rate
--    and billing_rate directly. Add the same RESTRICTIVE has_perm('contracts.edit')
--    write policies contracts already carries (restrictive, so they AND with the
--    permissive company/ssa policies: a write needs company membership AND the key).
--
-- 2) DATING. On an ACTIVE contract the committed TOTAL per (contract, category,
--    site) is a commercial term: it moves only through a dated addendum. But the
--    day/night SPLIT of that total is operational and must stay free. Because the
--    split is stored AS per-shift committed_count rows, the rule is a SUM
--    invariance: a change that keeps the group's committed sum constant (a
--    rebalance) is allowed; one that alters it is refused. Enforced by a DEFERRED
--    constraint trigger so a multi-statement rebalance is judged on its net effect
--    at commit, not mid-sequence. The rate columns have no rebalance and are
--    simply locked on Active. app.contract_amendment='1' is the only escape; the
--    super_admin exemption on enforce_contract_lock is dropped (raising an
--    addendum is no harder for a super_admin). Draft contracts stay editable.
--
-- 3) THE RPC. set_shift_split() is the sanctioned atomic writer of the split,
--    gated on assignments.hr (Shift Management is an ops action; its users may not
--    hold contracts.edit). It preserves the group total by construction, so it
--    passes the deferred check on merit — no special flag.
--
-- 4) DEAD COLUMNS. contract_lines.effective_from/effective_to are read by nothing
--    (addendums are the only honoured dating scheme); renew_contract merely copied
--    them. Amend it, then drop them.
--
-- 5) REPORT. contract_line_rate_vs_salary: per line, the billing rate, each
--    assigned guard's salary and the margin. Report only.

-- ── 1) RLS write gates (restrictive, mirroring contracts) ──────────────────────
do $mig$
declare t text;
begin
  foreach t in array array['contract_lines','contract_addendums','sites','shift_definitions'] loop
    execute format($f$
      create policy perm_write_ins on public.%I as restrictive for insert
        with check ((select public.has_perm('contracts.edit')));
      create policy perm_write_upd on public.%I as restrictive for update
        using ((select public.has_perm('contracts.edit')))
        with check ((select public.has_perm('contracts.edit')));
      create policy perm_write_del on public.%I as restrictive for delete
        using ((select public.has_perm('contracts.edit')));
    $f$, t, t, t);
  end loop;
end $mig$;

-- ── 2a) enforce_contract_lock: drop the super_admin exemption ──────────────────
-- Surgery (multi-author 0138+): remove the exemption block, asserted to appear
-- exactly once. The app.contract_amendment escape and the scalar-column lock stay.
do $mig$
declare
  v_src text; v_new text; v_cnt int;
  v_anchor text :=
'  -- Super-admins may edit an Active contract''s terms directly.
  if exists (
    select 1 from public.profiles
    where id = auth.uid() and role in (''super_admin'', ''super_super_admin'')
  ) then
    return new;
  end if;

';
begin
  v_src := pg_get_functiondef('public.enforce_contract_lock()'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_cnt <> 1 then raise exception '0450 REFUSED: enforce_contract_lock super_admin block found % times (want 1).', v_cnt; end if;
  v_new := replace(v_src, v_anchor, '');
  execute v_new;
end $mig$;

-- ── 2b) contract_lines rate lock (BEFORE UPDATE) ───────────────────────────────
-- Rates carry no rebalance: any change on an Active contract's line is a dated
-- change. Draft lines and app.contract_amendment='1' are exempt.
create or replace function public.enforce_contract_line_rate_lock()
 returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
declare v_status text;
begin
  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then return new; end if;
  select k.status into v_status from public.contracts k where k.id = new.contract_id;
  if v_status is distinct from 'active' then return new; end if;
  if new.unit_rate    is distinct from old.unit_rate
   or new.billing_rate is distinct from old.billing_rate
   or new.client_ot_rate is distinct from old.client_ot_rate then
    raise exception 'contract line rate is locked on an Active contract; change it via a dated addendum (RATE_CHANGE)'
      using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_contract_line_rate_lock on public.contract_lines;
create trigger trg_contract_line_rate_lock
  before update on public.contract_lines
  for each row execute function public.enforce_contract_line_rate_lock();

-- ── 2c) committed_count SUM invariance per (contract, category, site) ──────────
-- Baseline captured on the first touch of a group in a transaction (the pre-txn
-- sum), verified at COMMIT by a DEFERRED constraint trigger. A rebalance (net
-- delta 0) passes; any change to the group total is refused unless the contract is
-- Draft or app.contract_amendment='1'. Fires INSERT/UPDATE/DELETE — adding or
-- removing a shift row changes the sum as surely as editing one.
create or replace function public.contract_lines_capture_group_sum()
 returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
declare r record; v_ck text;
begin
  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;
  -- Session-temp baseline store. Not ON COMMIT DELETE ROWS: the deferred check
  -- runs during commit and could race the truncation. Bound growth by clearing
  -- prior transactions' rows instead (a session runs one txn at a time).
  create temp table if not exists cl_group_sum_baseline
    (txid bigint, ck text, base_sum int, primary key (txid, ck));
  delete from cl_group_sum_baseline where txid <> txid_current();
  v_ck := r.contract_id::text || '|' || r.category::text || '|' || coalesce(r.site_id::text, '~');
  -- First touch of this group in this txn: the table still holds the pre-txn state
  -- (this row's change is not applied in a BEFORE trigger; a multi-row statement
  -- sees its own snapshot), so this sum is the baseline.
  insert into cl_group_sum_baseline (txid, ck, base_sum)
  select txid_current(), v_ck,
         coalesce((select sum(cl.committed_count) from public.contract_lines cl
                    where cl.contract_id = r.contract_id
                      and cl.category = r.category
                      and cl.site_id is not distinct from r.site_id), 0)
  on conflict (txid, ck) do nothing;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

create or replace function public.contract_lines_group_sum_invariant()
 returns trigger language plpgsql security definer set search_path to 'public'
as $fn$
declare r record; v_ck text; v_base int; v_now int; v_status text;
begin
  if coalesce(current_setting('app.contract_amendment', true), '') = '1' then return null; end if;
  r := case when tg_op = 'DELETE' then old else new end;
  select k.status into v_status from public.contracts k where k.id = r.contract_id;
  if v_status is distinct from 'active' then return null; end if;   -- Draft: freely editable
  v_ck := r.contract_id::text || '|' || r.category::text || '|' || coalesce(r.site_id::text, '~');
  select base_sum into v_base from cl_group_sum_baseline where txid = txid_current() and ck = v_ck;
  if v_base is null then return null; end if;   -- amendment path captured nothing
  select coalesce(sum(cl.committed_count), 0) into v_now from public.contract_lines cl
    where cl.contract_id = r.contract_id and cl.category = r.category
      and cl.site_id is not distinct from r.site_id;
  if v_now <> v_base then
    raise exception 'the committed total for this post is locked on an Active contract (was %, now %); a rebalance keeps the total — change the total via a dated addendum.', v_base, v_now
      using errcode = '23514';
  end if;
  return null;
end $fn$;

drop trigger if exists trg_contract_lines_capture_group_sum on public.contract_lines;
create trigger trg_contract_lines_capture_group_sum
  before insert or update or delete on public.contract_lines
  for each row execute function public.contract_lines_capture_group_sum();

drop trigger if exists trg_contract_lines_group_sum_invariant on public.contract_lines;
create constraint trigger trg_contract_lines_group_sum_invariant
  after insert or update or delete on public.contract_lines
  deferrable initially deferred
  for each row execute function public.contract_lines_group_sum_invariant();

-- ── 3) set_shift_split — the sanctioned atomic split writer (assignments.hr) ────
create or replace function public.set_shift_split(
  p_contract_id uuid, p_category text, p_site_id uuid, p_day_count int, p_night_count int)
 returns void language plpgsql security definer set search_path to 'public'
as $fn$
declare
  v_total int; v_rep public.contract_lines%rowtype;
  v_day_id uuid; v_night_id uuid;
begin
  -- Permission first (skipped for cron/SQL and nested trigger writes).
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('assignments.hr');
  end if;
  if p_contract_id is not null then
    perform public.assert_same_company((select company_id from public.contracts where id = p_contract_id));
    perform public.assert_branch_writable((select c.branch_id from public.clients c
      join public.contracts k on k.client_id = c.id where k.id = p_contract_id));
  end if;
  -- tenant guard [resolved]: p_site_id owning company asserted directly.
  if p_site_id is not null then
    perform public.assert_same_company((select company_id from public.sites where id = p_site_id));
  end if;
  if p_day_count < 0 or p_night_count < 0 then
    raise exception 'Shift counts cannot be negative.' using errcode = '23514';
  end if;

  -- The split must sum to the committed total in force for the group — the total
  -- itself is a commercial term and moves only through an addendum.
  select coalesce(sum(committed_count), 0) into v_total from public.contract_lines
   where contract_id = p_contract_id and category::text = p_category
     and site_id is not distinct from p_site_id;
  if p_day_count + p_night_count <> v_total then
    raise exception 'Day + Night must equal the committed total of % for this post — raise an addendum to change the total.', v_total
      using errcode = '23514';
  end if;

  select * into v_rep from public.contract_lines
   where contract_id = p_contract_id and category::text = p_category
     and site_id is not distinct from p_site_id
   order by committed_count desc limit 1;

  select id into v_day_id   from public.contract_lines
   where contract_id = p_contract_id and category::text = p_category
     and site_id is not distinct from p_site_id and shift_code = 'day'   limit 1;
  select id into v_night_id from public.contract_lines
   where contract_id = p_contract_id and category::text = p_category
     and site_id is not distinct from p_site_id and shift_code = 'night' limit 1;

  -- Day row.
  if v_day_id is not null then
    update public.contract_lines set committed_count = p_day_count where id = v_day_id;
  elsif p_day_count > 0 and v_rep.id is not null then
    insert into public.contract_lines (company_id, contract_id, category, label, location,
      committed_count, unit_rate, cost_components, taxable, site_id, shift_code,
      billed_qty, relief_allowance, relief_mode, billing_rate, client_ot_rate)
    values (v_rep.company_id, p_contract_id, v_rep.category, v_rep.label, v_rep.location,
      p_day_count, v_rep.unit_rate, v_rep.cost_components, v_rep.taxable, p_site_id, 'day',
      v_rep.billed_qty, v_rep.relief_allowance, v_rep.relief_mode, v_rep.billing_rate, v_rep.client_ot_rate);
  end if;
  -- Night row.
  if v_night_id is not null then
    update public.contract_lines set committed_count = p_night_count where id = v_night_id;
  elsif p_night_count > 0 and v_rep.id is not null then
    insert into public.contract_lines (company_id, contract_id, category, label, location,
      committed_count, unit_rate, cost_components, taxable, site_id, shift_code,
      billed_qty, relief_allowance, relief_mode, billing_rate, client_ot_rate)
    values (v_rep.company_id, p_contract_id, v_rep.category, v_rep.label, v_rep.location,
      p_night_count, v_rep.unit_rate, v_rep.cost_components, v_rep.taxable, p_site_id, 'night',
      v_rep.billed_qty, v_rep.relief_allowance, v_rep.relief_mode, v_rep.billing_rate, v_rep.client_ot_rate);
  end if;

  -- Any other shift rows in the group carry their count into day/night, so they
  -- must go to zero or the group total would inflate past the committed total.
  update public.contract_lines set committed_count = 0
   where contract_id = p_contract_id and category::text = p_category
     and site_id is not distinct from p_site_id
     and coalesce(shift_code, '') not in ('day', 'night')
     and committed_count <> 0;
end $fn$;

grant execute on function public.set_shift_split(uuid, text, uuid, int, int) to authenticated;

-- ── 4) drop the dead effective_from/effective_to (amend renew_contract first) ───
do $mig$
declare
  v_src text; v_new text; v_cnt int;
  v_a1 text :=
'    relief_mode, billing_rate, client_ot_rate,
    effective_from, effective_to
  )';
  v_r1 text :=
'    relief_mode, billing_rate, client_ot_rate
  )';
  v_a2 text :=
'    l.relief_mode, l.billing_rate, l.client_ot_rate,
    l.effective_from, l.effective_to
  from public.contract_lines l';
  v_r2 text :=
'    l.relief_mode, l.billing_rate, l.client_ot_rate
  from public.contract_lines l';
begin
  v_src := pg_get_functiondef('public.renew_contract(uuid,date,date,boolean)'::regprocedure);
  v_cnt := (length(v_src) - length(replace(v_src, v_a1, ''))) / length(v_a1);
  if v_cnt <> 1 then raise exception '0450 REFUSED: renew_contract insert-list anchor found % times (want 1).', v_cnt; end if;
  v_cnt := (length(v_src) - length(replace(v_src, v_a2, ''))) / length(v_a2);
  if v_cnt <> 1 then raise exception '0450 REFUSED: renew_contract select-list anchor found % times (want 1).', v_cnt; end if;
  v_new := replace(v_src, v_a1, v_r1);
  v_new := replace(v_new, v_a2, v_r2);
  execute v_new;
end $mig$;

alter table public.contract_lines drop column effective_from, drop column effective_to;

-- ── 5) rate-vs-salary report ───────────────────────────────────────────────────
-- security_invoker so it obeys the caller's RLS (company scope) on the base tables.
create or replace view public.contract_line_rate_vs_salary
  with (security_invoker = true) as
select cl.id as contract_line_id, cl.contract_id, k.client_id, cl.category, cl.site_id, cl.shift_code,
       coalesce(cl.billing_rate, cl.unit_rate) as billing_rate,
       d.guard_id, e.full_name as guard_name,
       es.base_salary as guard_salary,
       coalesce(cl.billing_rate, cl.unit_rate) - es.base_salary as margin
  from public.contract_lines cl
  join public.contracts k on k.id = cl.contract_id
  left join public.deployments d on d.contract_line_id = cl.id and d.end_date is null
  left join public.employees e on e.id = d.guard_id
  left join lateral (
    select h.base_salary from public.employee_salary_history h
     where h.employee_id = d.guard_id and h.effective_date <= current_date
     order by h.effective_date desc limit 1) es on true
 where k.status = 'active';

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='contract_lines'
               and column_name in ('effective_from','effective_to')) then
    raise exception '0450 FAILED: dead effective_from/to columns still present.';
  end if;
  if position('super_admin' in pg_get_functiondef('public.enforce_contract_lock()'::regprocedure)) > 0 then
    raise exception '0450 FAILED: enforce_contract_lock still exempts super_admin.';
  end if;
  if (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid
       where c.relname in ('contract_lines','contract_addendums','sites','shift_definitions')
         and p.polname like 'perm_write_%') <> 12 then
    raise exception '0450 FAILED: expected 12 perm_write policies across the four tables.';
  end if;
end $mig$;

-- Tenant-guard tail: set_shift_split looks its company up from p_contract_id, so
-- no gap is opened.
do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0450 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
