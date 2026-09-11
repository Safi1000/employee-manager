-- 0433 — the opening stocktake is an opening balance.
--
-- Everything held today, at ACTUAL cost, plus everything already issued and out
-- on sites recorded as issued. Same shape as the bank opening batch: debited to
-- the inventory accounts, balanced to Opening Balance Equity.
--
-- IT NEEDS A VALUE AGAINST EVERY ITEM or the ledger does not know what is held,
-- so a line with no cost is refused rather than defaulted to zero — a zero
-- would balance perfectly and describe nothing.
--
-- WHAT IS ALREADY OUT IS RECORDED AS ISSUED, not as stock. It is not in the
-- store and counting it there would make every future issue impossible to
-- reconcile. It enters as a kit_event with costed_month already set, because
-- the client consumed that kit before any of this existed and charging it now
-- would land a year of historic kit on this month's profitability.
--
-- ── IT CANNOT USE opening_balance_batches, AND THAT IS A SCHEMA FACT ────────
--
-- "Same shape as the bank opening batch" is the right instruction and the wrong
-- table. opening_balance_batches carries
--
--     idx_ob_one_posted_per_company  unique (company_id) where status = 'posted'
--
-- — ONE posted opening batch per company, ever. GGS already holds a draft
-- "Opening trial balance" dated 2026-09-03 that is waiting to be posted, and an
-- inventory stocktake posted into that table would either collide with it or
-- consume the single slot it is owed.
--
-- So the stocktake gets its own handle with the same DISCIPLINE — one per
-- company, dated, posted once, carrying its journal entry — rather than the
-- same table. Folding inventory into the trial-balance batch would also mean
-- one act posting two unrelated openings, and whichever was entered second
-- would silently be unable to be corrected without the first.

create table if not exists public.inventory_opening_batches (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  as_of_date       date not null,
  total_actual     numeric(14,2) not null default 0,
  posted_at        timestamptz,
  posted_by        uuid,
  journal_entry_id uuid,
  created_at       timestamptz not null default now()
);

-- SET ONCE, like the bank opening. A second stocktake is a correction, and a
-- correction to an opening balance is a deliberate act rather than a re-run.
create unique index if not exists inventory_opening_one_per_company
  on public.inventory_opening_batches (company_id);

alter table public.inventory_opening_batches enable row level security;
drop policy if exists company_members on public.inventory_opening_batches;
create policy company_members on public.inventory_opening_batches for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.inventory_opening_batches;
create policy ssa_all on public.inventory_opening_batches for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
drop policy if exists perm_write_ins on public.inventory_opening_batches;
create policy perm_write_ins on public.inventory_opening_batches as restrictive
  for insert to public with check (public.has_perm('inventory.edit'));
drop policy if exists perm_write_upd on public.inventory_opening_batches;
create policy perm_write_upd on public.inventory_opening_batches as restrictive
  for update to public using (public.has_perm('inventory.edit'))
  with check (public.has_perm('inventory.edit'));
grant select, insert, update on public.inventory_opening_batches to authenticated;

drop trigger if exists trg_aaa_inv_opening_fill_company on public.inventory_opening_batches;
create trigger trg_aaa_inv_opening_fill_company before insert on public.inventory_opening_batches
  for each row execute function public.fill_company_id();

create or replace function public.record_opening_stock(
  p_as_of date,
  p_lines jsonb)   -- [{item_type_id, size, grade, serial_number, licence_expiry,
                   --   quantity, unit_actual_cost, holder_employee_id, site_id}]
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_co     uuid;
  v_batch  uuid;
  v_line   jsonb;
  v_type   public.inventory_item_types%rowtype;
  v_qty    int;
  v_unit   numeric;
  v_size   text;
  v_grade  public.stock_grade;
  v_serial text;
  v_holder uuid;
  v_site   uuid;
  v_client uuid;
  v_issue  uuid;
  v_total  numeric := 0;
  v_lines  jsonb := '[]'::jsonb;
  v_entry  uuid;
  v_stock  uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('inventory.edit');
  end if;
  v_co := public.current_company_id();
  if v_co is null then raise exception 'No company in scope'; end if;
  perform public.ensure_inventory_accounts(v_co);

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'An opening stocktake needs at least one line.';
  end if;

  -- ONE BATCH, so the whole stocktake is a single dated act that can be found
  -- again — the same discipline the bank opening batch has, in its own table
  -- for the reason in the header.
  insert into public.inventory_opening_batches (company_id, as_of_date)
  values (v_co, p_as_of)
  returning id into v_batch;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_type from public.inventory_item_types
     where id = (v_line->>'item_type_id')::uuid and company_id = v_co;
    if v_type.id is null then raise exception 'Unknown item type on an opening line.'; end if;

    v_qty    := (v_line->>'quantity')::int;
    v_unit   := nullif(v_line->>'unit_actual_cost', '')::numeric;
    v_size   := nullif(v_line->>'size', '');
    v_grade  := coalesce(nullif(v_line->>'grade', ''), 'new')::public.stock_grade;
    v_serial := nullif(v_line->>'serial_number', '');
    v_holder := nullif(v_line->>'holder_employee_id', '')::uuid;
    v_site   := nullif(v_line->>'site_id', '')::uuid;

    -- A VALUE AGAINST EVERY ITEM. Null is refused; zero would balance and say
    -- nothing about what is held.
    if v_unit is null then
      raise exception
        'ITEM "%" HAS NO COST. An opening stocktake carries actual cost against every line, or the ledger does not know what is held. A zero would balance and describe nothing.',
        v_type.name;
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Item "%" needs a quantity.', v_type.name;
    end if;

    v_total := v_total + (v_qty * v_unit);
    v_lines := v_lines || jsonb_build_object(
      'key', v_type.inventory_key, 'debit', v_qty * v_unit, 'credit', 0);

    if v_holder is null and v_site is null then
      -- ---- IN THE STORE ----
      if v_serial is not null then
        insert into public.inventory_stock
          (company_id, item_type_id, size, grade, serial_number, licence_expiry,
           quantity, unit_actual_cost)
        values (v_co, v_type.id, v_size, v_grade, v_serial,
                nullif(v_line->>'licence_expiry', '')::date, v_qty, v_unit);
      else
        select id into v_stock from public.inventory_stock
         where company_id = v_co and item_type_id = v_type.id
           and coalesce(size, '') = coalesce(v_size, '') and grade = v_grade
           and serial_number is null for update;
        if v_stock is null then
          insert into public.inventory_stock
            (company_id, item_type_id, size, grade, quantity, unit_actual_cost)
          values (v_co, v_type.id, v_size, v_grade, v_qty, v_unit);
        else
          update public.inventory_stock
             set quantity = quantity + v_qty, updated_at = now() where id = v_stock;
        end if;
      end if;
    else
      -- ---- ALREADY OUT ----
      if v_holder is not null then
        select d.client_id into v_client from public.deployments d
         where d.guard_id = v_holder and d.end_date is null
         order by d.start_date desc limit 1;
      else
        select s.client_id into v_client from public.sites s where s.id = v_site;
      end if;

      insert into public.kit_events
        (company_id, event, event_date, item_type_id, size, grade, serial_number,
         quantity, to_employee_id, site_id, client_id, condition, received_condition,
         unit_actual_cost,
         -- COSTED ALREADY, deliberately. The client consumed this kit before any
         -- of this existed; charging it now would land a year of historic
         -- issuance on this month's client profitability and on partner shares.
         costed_month, notes, created_by)
      values (v_co, 'issue', p_as_of, v_type.id, v_size, v_grade, v_serial,
              v_qty, v_holder, v_site, v_client, 'fair', 'fair', v_unit,
              date_trunc('month', p_as_of)::date, 'Opening stocktake', auth.uid())
      returning id into v_issue;
      update public.kit_events set issue_id = v_issue where id = v_issue;
    end if;
  end loop;

  if v_total <= 0 then
    raise exception 'An opening stocktake with no value is not an opening balance.';
  end if;

  v_lines := v_lines || jsonb_build_object(
    'key', 'opening_balance_equity', 'debit', 0, 'credit', v_total);

  v_entry := public.post_journal(
    v_co, p_as_of, 'Opening stocktake — inventory',
    'inventory_opening', v_batch, false, v_lines);

  update public.inventory_opening_batches
     set total_actual = v_total, posted_at = now(), posted_by = auth.uid(),
         journal_entry_id = v_entry
   where id = v_batch;

  return v_batch;
end;
$fn$;

comment on function public.record_opening_stock(date, jsonb) is
  '0433: the opening stocktake — everything held at actual cost plus everything already out, as ONE opening balance batch: Dr the inventory accounts, Cr Opening Balance Equity. Refuses a line with no cost, because a zero balances and describes nothing. Kit already issued enters with costed_month already set, so a year of historic issuance does not land on this month''s client profitability.';

revoke execute on function public.record_opening_stock(date, jsonb) from anon, public;
grant  execute on function public.record_opening_stock(date, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Probe. Rollback only.
-- ---------------------------------------------------------------------------
-- IT RUNS AS A SESSION, NOT AS THE MIGRATION. record_opening_stock is SECURITY
-- INVOKER and reads current_company_id(), which is null for postgres with no
-- JWT — so called bare it raises "No company in scope" and never reaches the
-- rule under test. The first draft of this probe did exactly that and reported
-- a pass for the wrong reason until the migration refused. A probe for an
-- invoker function has to be a probe of a caller.
do $$
declare v_co uuid; v_t uuid; v_uid uuid;
begin
  select p.id, p.company_id into v_uid, v_co
    from public.profiles p
    join public.companies c on c.id = p.company_id
   where c.active and c.archived_at is null
   order by p.created_at limit 1;
  if v_uid is null then raise notice '0433: no profile to probe as; skipped.'; return; end if;

  begin
    insert into public.inventory_item_types
      (company_id, name, category, issuable, replacement_cost, useful_life_months, sized)
    values (v_co, '0433 probe uniform', 'uniform', true, 2000, 24, true)
    returning id into v_t;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);

    -- A LINE WITH NO COST IS REFUSED. This is the assertion worth having: the
    -- failure it prevents is an opening balance that balances at zero and tells
    -- nobody what is in the store.
    begin
      perform public.record_opening_stock(current_date,
        jsonb_build_array(jsonb_build_object(
          'item_type_id', v_t, 'size', 'L', 'quantity', 10)));
      raise exception '0433 FAILED: a line with no cost was accepted.';
    exception when others then
      if sqlerrm not like '%HAS NO COST%' then
        raise exception '0433 FAILED: the valueless line was refused, but not by the rule under test. Got: %', sqlerrm;
      end if;
    end;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      perform set_config('request.jwt.claims', null, true);
      perform set_config('request.jwt.claim.sub', null, true);
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0433: probe passed — a valueless opening line is refused.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- record_opening_stock is INVOKER and takes no company — it reads
-- current_company_id() — so it has no uuid parameter for the detector to want.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0433 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
