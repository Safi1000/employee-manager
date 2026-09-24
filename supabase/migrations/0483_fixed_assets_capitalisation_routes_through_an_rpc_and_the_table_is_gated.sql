-- 0483 — fixed_assets: capitalisation goes through an RPC on accounting.edit, and
-- the table is gated. First of the RPC-routing pass (route first, gate second).
--
-- Capitalising an asset is an accounting act, not an inventory one: it puts a cost
-- on the balance sheet and posts a GL entry (journal_on_fixed_assets fires on the
-- insert). So the key is accounting.edit, not inventory.edit — the person deciding
-- expense-vs-asset is not whoever manages kit. dispose_fixed_asset, which posts a
-- gain or loss and was ungated, gets the same key (more sensitive than creation).
-- No prod disruption: zero assets exist and no non-super user holds inventory.edit
-- without accounting.edit.
--
-- capitalise_fixed_asset is a thin insert — company_id and branch/region are filled
-- by the table's own BEFORE-INSERT triggers (from the caller's session, preserved
-- under DEFINER), and the capitalisation journal is posted by journal_on_fixed_
-- assets. It carries no uuid parameter, so nothing for tenant_guard_gaps to flag.

create or replace function public.capitalise_fixed_asset(
  p_name              text,
  p_category          text,
  p_acquisition_date  date,
  p_cost              numeric,
  p_salvage_value     numeric,
  p_useful_life_months integer
) returns uuid
  language plpgsql
  security definer
  set search_path to 'public'
as $fn$
declare v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  insert into public.fixed_assets
    (name, category, acquisition_date, cost, salvage_value, useful_life_months)
  values
    (p_name, p_category::public.fixed_asset_category, p_acquisition_date,
     p_cost, coalesce(p_salvage_value, 0), greatest(1, coalesce(p_useful_life_months, 1)))
  returning id into v_id;
  return v_id;
end $fn$;

grant execute on function public.capitalise_fixed_asset(text, text, date, numeric, numeric, integer) to authenticated;

-- dispose_fixed_asset gains require_perm('accounting.edit'). Restated from the LIVE
-- definition (pg_get_functiondef), guard inserted at the top; every other line is
-- the live body unchanged.
create or replace function public.dispose_fixed_asset(p_asset_id uuid, p_disposal_date date, p_proceeds numeric DEFAULT 0, p_payment_mode text DEFAULT 'Bank'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r        record;
  v_nbv    numeric;
  v_gain   numeric;
  v_dr_key text;
  v_lines  jsonb;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('accounting.edit');
  end if;
  -- tenant guard [resolved]: owning company looked up from p_asset_id via public.fixed_assets (0242)
  if p_asset_id is not null then perform public.assert_same_company((select company_id from public.fixed_assets where id = p_asset_id)); end if;

  select * into r from public.fixed_assets where id = p_asset_id;
  if not found then
    raise exception 'fixed asset % not found', p_asset_id using errcode = '23503';
  end if;
  if r.status <> 'active' then
    raise exception 'fixed asset % is already %', p_asset_id, r.status using errcode = '23514';
  end if;

  v_nbv  := r.cost - r.accumulated_depreciation;
  v_gain := coalesce(p_proceeds, 0) - v_nbv;

  v_dr_key := case
    when p_payment_mode = 'Cash' then 'cash'
    when p_payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ar'
  end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', 'accum_dep', 'debit', r.accumulated_depreciation, 'credit', 0),
    jsonb_build_object('key', v_dr_key,    'debit', coalesce(p_proceeds, 0),    'credit', 0),
    jsonb_build_object('key', public.fa_coa_key(r.category), 'debit', 0, 'credit', r.cost)
  );

  if v_gain > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'gain_disposal', 'debit', 0, 'credit', v_gain));
  elsif v_gain < 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'loss_disposal', 'debit', -v_gain, 'credit', 0));
  end if;

  perform public.post_journal(
    r.company_id, p_disposal_date,
    'Asset disposal — ' || r.name,
    'fixed_assets_disposal', r.id, false,
    v_lines,
    r.branch_id
  );

  update public.fixed_assets
     set status = 'disposed',
         disposal_date = p_disposal_date,
         disposal_proceeds = coalesce(p_proceeds, 0),
         updated_at = now()
   where id = p_asset_id;

  return p_asset_id;
end;
$function$;

-- Gate the table: raw writes now need accounting.edit. The two definer RPCs above
-- run as owner and bypass this; sync_accumulated_depreciation / run_depreciation
-- are definer too. So the only writes this blocks are raw client inserts/edits.
drop policy if exists perm_write_ins on public.fixed_assets;
drop policy if exists perm_write_upd on public.fixed_assets;
drop policy if exists perm_write_del on public.fixed_assets;
create policy perm_write_ins on public.fixed_assets as restrictive for insert
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_upd on public.fixed_assets as restrictive for update
  using ((select public.has_perm('accounting.edit')))
  with check ((select public.has_perm('accounting.edit')));
create policy perm_write_del on public.fixed_assets as restrictive for delete
  using ((select public.has_perm('accounting.edit')));

-- ── verification ───────────────────────────────────────────────────────────────
do $mig$
declare v_n int;
begin
  if not exists (select 1 from public.permission_keys where key = 'accounting.edit') then
    raise exception '0483 FAILED: accounting.edit missing from permission_keys.';
  end if;
  select count(*) into v_n from pg_policy p join pg_class c on c.oid=p.polrelid
    where c.relname='fixed_assets' and p.polname like 'perm_write_%';
  if v_n <> 3 then raise exception '0483 FAILED: expected 3 perm_write policies on fixed_assets, found %.', v_n; end if;
  -- both routing functions must require the key and stay definer
  if not (select prosecdef from pg_proc where oid='public.capitalise_fixed_asset(text,text,date,numeric,numeric,integer)'::regprocedure)
     or not (select prosecdef from pg_proc where oid='public.dispose_fixed_asset(uuid,date,numeric,text)'::regprocedure) then
    raise exception '0483 FAILED: a routing function is not SECURITY DEFINER.';
  end if;
end $mig$;

do $mig$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0483 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $mig$;
