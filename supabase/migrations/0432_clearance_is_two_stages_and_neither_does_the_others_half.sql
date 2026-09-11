-- 0432 — clearance is two stages, and neither does the other's half.
--
-- Ops assesses the kit: every item, its condition, its fine. Finance settles the
-- dues and sees only the OUTCOME — kits recovered, or a fine of X. Finance
-- cannot see the guard at all until ops has cleared him.
--
-- THIS IS THE STAGE-GATE EXCEPTION IN CLAUDE.md, and it is the textbook case:
-- both stages write clearance_certificates, so the ordinary rule ("require what
-- a direct write to the target table would require") gives one key for both and
-- lets one person do the whole thing. The test is "would one key let one person
-- complete a sequence the design requires two people to complete", and here it
-- plainly would. So the key follows the STAGE:
--
--   clearance.ops      — assess the kit, set fines, clear stage 1
--   clearance.finance  — settle dues, record the signature, release payment
--
-- Both keys are added to public.permission_keys here AND to PERMISSION_GROUPS
-- in src/app/lib/supabase.ts in the same change. A key the grant screen cannot
-- offer is a key nobody can be given, and every_demanded_permission_is_grantable
-- goes red that night — which is the point of it.

insert into public.permission_keys (key, grp, label)
select v.key, v.grp, v.label from (values
  ('clearance.ops',     'Workforce', 'Clearance — assess kit (Operations)'),
  ('clearance.finance', 'Finance',   'Clearance — settle dues (Finance)')
) v(key, grp, label)
where not exists (select 1 from public.permission_keys k where k.key = v.key);

-- ---------------------------------------------------------------------------
-- 1. THE CERTIFICATE GROWS THE HALF IT NEVER HAD.
-- ---------------------------------------------------------------------------
alter table public.clearance_certificates
  add column if not exists ops_cleared_at   timestamptz,
  add column if not exists ops_cleared_by   uuid,
  add column if not exists kit_fine_total   numeric(14,2) not null default 0,
  add column if not exists kit_summary      text,
  -- THE WET SIGNATURE. The certificate prints, he signs it, someone records
  -- that here — and only then may the payment go out.
  add column if not exists signed_at        timestamptz,
  add column if not exists signed_by        uuid,
  -- THE DATE THE CERTIFICATE COVERS, and the cumulative figure that goes with
  -- the wording. "All dues to 8 September are cleared" beside eight days' pay
  -- says everything is settled while the number beside it says otherwise.
  add column if not exists covers_to        date,
  add column if not exists cumulative_paid  numeric(14,2) not null default 0,
  add column if not exists fine_written_off numeric(14,2) not null default 0;

comment on column public.clearance_certificates.cumulative_paid is
  '0432: the CUMULATIVE total paid to this guard to date, not this payment. The certificate says "all dues to <date> are cleared", and a cumulative sentence beside a single payment''s figure is a document he can argue with.';

comment on column public.clearance_certificates.signed_at is
  '0432: when the printed certificate came back signed. Payment waits on this — dues_released cannot be set while it is null.';

-- ---------------------------------------------------------------------------
-- 2. THE KIT ASSESSMENT. One row per outstanding holding, three outcomes.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type where typname = 'kit_clearance_outcome') then
    create type public.kit_clearance_outcome as enum
      ('returned_reusable', 'returned_unusable', 'not_returned');
  end if;
end $$;

create table if not exists public.clearance_kit_items (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  certificate_id  uuid not null references public.clearance_certificates(id) on delete cascade,
  issue_id        uuid not null references public.kit_events(id) on delete restrict,

  item_type_id    uuid not null references public.inventory_item_types(id) on delete restrict,
  size            text,
  quantity        integer not null,

  -- What he took it on at. Copied from the holding so a later handover cannot
  -- change what he was judged against.
  opening_condition public.kit_condition not null default 'new',

  outcome            public.kit_clearance_outcome,
  returned_condition public.kit_condition,

  -- SUGGESTED, NEVER IMPOSED. `suggested_fine` is what the rules produce;
  -- `fine` is what is charged, and it starts equal and is overridable by hand.
  suggested_fine  numeric(14,2) not null default 0,
  fine            numeric(14,2) not null default 0,
  fine_note       text,

  assessed_by     uuid,
  assessed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint clearance_kit_items_qty_positive check (quantity > 0),
  constraint clearance_kit_items_fine_nonneg check (fine >= 0 and suggested_fine >= 0),
  constraint clearance_kit_items_one_per_issue unique (certificate_id, issue_id)
);

alter table public.clearance_kit_items enable row level security;
drop policy if exists company_members on public.clearance_kit_items;
create policy company_members on public.clearance_kit_items for all to public
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
drop policy if exists ssa_all on public.clearance_kit_items;
create policy ssa_all on public.clearance_kit_items for all to public
  using (public.is_ssa_unscoped()) with check (public.is_ssa_unscoped());
-- WRITING AN ASSESSMENT IS OPS'S ACT. Finance holds clearance.finance and
-- cannot touch a fine.
drop policy if exists perm_write_ins on public.clearance_kit_items;
create policy perm_write_ins on public.clearance_kit_items as restrictive
  for insert to public with check (public.has_perm('clearance.ops'));
drop policy if exists perm_write_upd on public.clearance_kit_items;
create policy perm_write_upd on public.clearance_kit_items as restrictive
  for update to public using (public.has_perm('clearance.ops'))
  with check (public.has_perm('clearance.ops'));
drop policy if exists perm_write_del on public.clearance_kit_items;
create policy perm_write_del on public.clearance_kit_items as restrictive
  for delete to public using (public.has_perm('clearance.ops'));

grant select, insert, update, delete on public.clearance_kit_items to authenticated;

drop trigger if exists trg_aaa_clearance_kit_items_fill_company on public.clearance_kit_items;
create trigger trg_aaa_clearance_kit_items_fill_company before insert on public.clearance_kit_items
  for each row execute function public.fill_company_id();

-- ---------------------------------------------------------------------------
-- 3. THE SUGGESTED FINE.
--
--   Returned reusable  → nothing. Stock goes back at half replacement cost
--                        (return_kit, 0430), and used stock returning a second
--                        time stays at half rather than halving again.
--   Returned unusable  → PRO-RATED by remaining useful life, zero past it. A
--                        worn-out uniform past its life is normal wear, not
--                        damage.
--   Not returned       → FULL replacement cost, whatever its age. A lost item
--                        is a loss however old it was.
--
-- ADJUSTED FOR THE CONDITION HE RECEIVED IT IN. A guard handed a rough uniform
-- is not charged for the wear that was already on it, so the pro-rated fine is
-- scaled by the state he took it on at. The not-returned case is deliberately
-- NOT scaled: the spec is explicit that a loss is full replacement regardless,
-- and scaling it would let a worn item be lost cheaply.
-- ---------------------------------------------------------------------------
create or replace function public.suggest_kit_fine(
  p_issue_id uuid,
  p_outcome  text,
  p_returned_condition text default null)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_h      public.kit_holdings%rowtype;
  v_t      public.inventory_item_types%rowtype;
  v_from   date;
  v_months numeric;
  v_left   numeric;
  v_factor numeric;
begin
  -- tenant guard [resolved]: owning company looked up from p_issue_id via public.kit_events (0242)
  -- IT GOES FIRST, before any read: a function that reads a row and then asks
  -- whether it was allowed to has already done the thing it is checking.
  if p_issue_id is not null then
    perform public.assert_same_company((select company_id from public.kit_events where id = p_issue_id));
  end if;

  select * into v_h from public.kit_holdings where issue_id = p_issue_id;
  if v_h.issue_id is null then return 0; end if;

  select * into v_t from public.inventory_item_types where id = v_h.item_type_id;
  if v_t.id is null then return 0; end if;

  if p_outcome = 'returned_reusable' then return 0; end if;

  if p_outcome = 'not_returned' then
    return round(v_t.replacement_cost * v_h.outstanding_qty, 2);
  end if;

  -- returned_unusable: pro-rate by the life LEFT when it came back.
  v_from   := coalesce(v_h.last_event_date, v_h.issued_on);
  v_months := greatest(v_t.useful_life_months, 1);
  v_left   := greatest(v_months - (current_date - v_h.issued_on) / 30.0, 0);
  if v_left <= 0 then return 0; end if;

  -- The state he took it on at. Wear that was already there is not his.
  v_factor := case v_h.opening_condition
    when 'new'   then 1.0
    when 'good'  then 0.85
    when 'fair'  then 0.60
    when 'rough' then 0.30
    else 0.0
  end;

  return round(v_t.replacement_cost * v_h.outstanding_qty
               * (v_left / v_months) * v_factor, 2);
end;
$fn$;

comment on function public.suggest_kit_fine(uuid, text, text) is
  '0432: the SUGGESTED fine for one outstanding holding. Reusable nothing; unusable pro-rated by remaining useful life and scaled by the condition the guard RECEIVED it in, zero past its life; not returned full replacement cost regardless of age. Suggested, never imposed — clearance_kit_items.fine is overridable by hand and is what is charged.';

revoke execute on function public.suggest_kit_fine(uuid, text, text) from anon, public;
grant  execute on function public.suggest_kit_fine(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. OPENING THE ASSESSMENT — his outstanding kit, listed automatically.
-- ---------------------------------------------------------------------------
create or replace function public.open_kit_clearance(p_employee_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare v_co uuid; v_cert uuid; v_lwd date; v_n int := 0; h record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('clearance.ops');
  end if;

  select company_id, last_working_day into v_co, v_lwd
    from public.employees where id = p_employee_id;
  if v_co is null then raise exception 'Employee not found.'; end if;

  -- A GUARD IS CLEARED AFTER HIS LAST WORKING DAY, never before. Clearing him
  -- early would lock the attendance of days he is still going to work.
  if v_lwd is null then
    raise exception 'This guard has not been separated yet. Record the separation first.';
  end if;
  if v_lwd > current_date then
    raise exception 'His last working day is %. A guard is cleared after it, not before.', v_lwd;
  end if;

  select id into v_cert from public.clearance_certificates
   where employee_id = p_employee_id and not dues_released
   order by created_at desc limit 1;
  if v_cert is null then
    insert into public.clearance_certificates (company_id, employee_id, covers_to)
    values (v_co, p_employee_id, v_lwd) returning id into v_cert;
  end if;

  for h in select * from public.kit_holdings where holder_employee_id = p_employee_id
  loop
    insert into public.clearance_kit_items
      (company_id, certificate_id, issue_id, item_type_id, size, quantity, opening_condition)
    values (v_co, v_cert, h.issue_id, h.item_type_id, h.size, h.outstanding_qty, h.opening_condition)
    on conflict (certificate_id, issue_id) do nothing;
    v_n := v_n + 1;
  end loop;

  update public.clearance_certificates
     set covers_to = coalesce(covers_to, v_lwd), updated_at = now()
   where id = v_cert;

  return v_cert;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. OPS CLEARS. Stock, write-offs and the fine, in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.ops_clear_employee(p_certificate_id uuid)
returns numeric
language plpgsql
security invoker
set search_path to 'public'
as $fn$
declare
  v_co uuid; v_emp uuid; v_total numeric := 0; v_recovered int := 0; v_lost int := 0;
  it record;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm('clearance.ops');
  end if;

  select company_id, employee_id into v_co, v_emp
    from public.clearance_certificates where id = p_certificate_id;
  if v_co is null then raise exception 'No such clearance.'; end if;

  if exists (select 1 from public.clearance_kit_items
              where certificate_id = p_certificate_id and outcome is null) then
    raise exception 'Every item needs an outcome before this guard can be cleared.';
  end if;

  for it in select * from public.clearance_kit_items where certificate_id = p_certificate_id
  loop
    -- Returned kit goes back through return_kit, which is the only thing that
    -- moves stock — including the half-replacement valuation and the rule that
    -- unusable kit does not go back on the shelf.
    if it.outcome in ('returned_reusable', 'returned_unusable')
       and exists (select 1 from public.kit_holdings where issue_id = it.issue_id) then
      perform public.return_kit(
        it.issue_id, it.quantity,
        case when it.outcome = 'returned_unusable' then 'unusable'
             else coalesce(it.returned_condition::text, 'good') end,
        current_date, 'Clearance');
      v_recovered := v_recovered + 1;
    elsif it.outcome = 'not_returned' then
      v_lost := v_lost + 1;
    end if;
    v_total := v_total + coalesce(it.fine, 0);
  end loop;

  update public.clearance_certificates
     set ops_cleared_at = now(),
         ops_cleared_by = auth.uid(),
         kit_fine_total = v_total,
         -- ONE LINE, and it is what FINANCE sees. Finance is not shown the
         -- items, the conditions or the per-item fines: it settles money.
         kit_summary = case when v_total > 0
           then 'A fine of PKR ' || to_char(v_total, 'FM999,999,999.00') || ' was imposed.'
           else 'All kits recovered in good condition.' end,
         outstanding_kit_count = v_lost,
         kit_returned = (v_lost = 0),
         updated_at = now()
   where id = p_certificate_id;

  return v_total;
end;
$fn$;

revoke execute on function public.open_kit_clearance(uuid) from anon, public;
grant  execute on function public.open_kit_clearance(uuid) to authenticated;
revoke execute on function public.ops_clear_employee(uuid) from anon, public;
grant  execute on function public.ops_clear_employee(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. FINANCE CANNOT SEE HIM UNTIL OPS HAS CLEARED HIM.
--
-- A view rather than a policy, because the rule is about a QUEUE and not about
-- row visibility: the certificate row must stay readable to ops the whole time.
-- ---------------------------------------------------------------------------
create or replace view public.clearance_finance_queue as
select c.id as certificate_id,
       c.company_id,
       c.employee_id,
       e.full_name,
       e.guard_code,
       c.covers_to,
       c.undisbursed_salary,
       c.outstanding_advance,
       -- THE OUTCOME ONLY. Not the items, not the conditions, not the per-item
       -- fines: those are ops's business and finance settles money.
       c.kit_fine_total,
       c.kit_summary,
       c.cumulative_paid,
       c.signed_at,
       c.dues_released,
       c.ops_cleared_at
  from public.clearance_certificates c
  join public.employees e on e.id = c.employee_id
 where c.ops_cleared_at is not null;

grant select on public.clearance_finance_queue to authenticated;

comment on view public.clearance_finance_queue is
  '0432: what FINANCE sees — and only after ops has cleared him. Carries the outcome (kits recovered, or a fine of X) and never the per-item assessment, which is ops''s half.';

-- ---------------------------------------------------------------------------
-- 7. OPS-CLEARING LOCKS HIS ATTENDANCE.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_cleared_attendance_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_emp uuid; v_when timestamptz;
begin
  -- NEW does not exist on a DELETE and plpgsql cannot coalesce two records, so
  -- the row is chosen by the operation rather than by a null test.
  if tg_op = 'DELETE' then v_emp := old.employee_id; else v_emp := new.employee_id; end if;

  select max(ops_cleared_at) into v_when
    from public.clearance_certificates
   where employee_id = v_emp and ops_cleared_at is not null;

  if v_when is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  raise exception
    'This guard was cleared on %. No attendance can be recorded or edited against him after clearance.',
    v_when::date
    using errcode = 'P0001';
end;
$fn$;

drop trigger if exists trg_cleared_attendance_lock on public.attendance_records;
create trigger trg_cleared_attendance_lock
  before insert or update or delete on public.attendance_records
  for each row execute function public.enforce_cleared_attendance_lock();

-- ---------------------------------------------------------------------------
-- 8. AN UNCLEARED GUARD IS INVISIBLE — so something has to look for him.
--
-- Finance cannot see him until ops clears. A guard fired and never cleared
-- therefore sits with nobody owed and nobody chasing, and his kit is out there.
-- ---------------------------------------------------------------------------
create or replace function public.uncleared_separations(p_company_id uuid)
returns table (
  employee_id      uuid,
  employee_name    text,
  last_working_day date,
  days_open        integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare v_sla int;
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  select clearance_sla_days into v_sla
    from public.inventory_settings where company_id = p_company_id;
  v_sla := coalesce(v_sla, 7);

  return query
  select e.id, e.full_name, e.last_working_day,
         (current_date - e.last_working_day)::int
    from public.employees e
   where e.company_id = p_company_id
     and e.lifecycle_state in ('fired', 'left', 'absconded')
     and e.last_working_day is not null
     and e.last_working_day < current_date - v_sla
     and not exists (
       select 1 from public.clearance_certificates c
        where c.employee_id = e.id and c.ops_cleared_at is not null)
   order by e.last_working_day;
end;
$fn$;

comment on function public.uncleared_separations(uuid) is
  '0432: separations older than inventory_settings.clearance_sla_days that ops has never cleared. Finance cannot see such a guard at all, so without this he sits with nobody owed and nobody chasing and his kit stays out there. Routed through compliance_upcoming, which already alerts.';

revoke execute on function public.uncleared_separations(uuid) from anon, public;
grant  execute on function public.uncleared_separations(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. ROUTE IT THROUGH THE COMPLIANCE CALENDAR. SURGERY on compliance_upcoming,
--    which is a UNION ALL of arms and is extended by adding one.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text; v_new text; v_hits int;
  a_tail text := '        )
 SELECT company_id,
    branch_id,
    kind,
    ref_id,
    label,
    due_date,
    notice_days,
    due_date - CURRENT_DATE AS days_remaining,
    sublabel
   FROM items i;';
begin
  select pg_get_viewdef('public.compliance_upcoming'::regclass, true) into v_def;

  v_hits := (length(v_def) - length(replace(v_def, a_tail, ''))) / length(a_tail);
  if v_hits <> 1 then
    raise exception '0432 REFUSED: the compliance_upcoming tail anchor appears % time(s), expected 1.', v_hits;
  end if;

  v_new := replace(v_def, a_tail,
'        UNION ALL
         SELECT e.company_id,
            e.branch_id,
            ''uncleared_separation''::text,
            e.id,
            ''Uncleared separation — ''::text || e.full_name,
            e.last_working_day,
            0,
            COALESCE(e.guard_code, e.employee_code, ''''::text)
           FROM employees e
          WHERE e.lifecycle_state = ANY (ARRAY[''fired''::employee_lifecycle_state, ''left''::employee_lifecycle_state, ''absconded''::employee_lifecycle_state])
            AND e.last_working_day IS NOT NULL
            AND NOT (EXISTS ( SELECT 1
                   FROM clearance_certificates c
                  WHERE c.employee_id = e.id AND c.ops_cleared_at IS NOT NULL))
        )
 SELECT company_id,
    branch_id,
    kind,
    ref_id,
    label,
    due_date,
    notice_days,
    due_date - CURRENT_DATE AS days_remaining,
    sublabel
   FROM items i;');

  execute 'create or replace view public.compliance_upcoming as ' || v_new;
  raise notice '0432: compliance_upcoming now carries uncleared separations.';
end $$;

-- ---------------------------------------------------------------------------
-- 10. Probe. Rollback only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_co uuid; v_t uuid; v_g uuid; v_issue uuid; v_fine numeric;
begin
  select id into v_co from public.companies where active and archived_at is null
   order by created_at limit 1;
  select id into v_g from public.employees where company_id = v_co order by created_at limit 1;
  if v_g is null then raise notice '0432: no fixture; skipped.'; return; end if;

  begin
    insert into public.inventory_item_types
      (company_id, name, category, issuable, replacement_cost, useful_life_months, sized)
    values (v_co, '0432 probe uniform', 'uniform', true, 2000, 24, true)
    returning id into v_t;

    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       to_employee_id, condition, received_condition, unit_actual_cost, event_date)
    values (v_co, 'issue', null, v_t, 'L', 'new', 1, v_g, 'new', 'new', 900, current_date)
    returning id into v_issue;
    update public.kit_events set issue_id = v_issue where id = v_issue;

    -- NOT RETURNED IS FULL REPLACEMENT, not the 900 it actually cost. Using
    -- actual cost here is the collapse 0429 exists to prevent: the company must
    -- buy a replacement at 2000.
    v_fine := public.suggest_kit_fine(v_issue, 'not_returned');
    if v_fine <> 2000 then
      raise exception '0432 FAILED: a lost uniform suggests % — replacement is 2000 and actual was 900. The two costs have collapsed.', v_fine;
    end if;

    -- Reusable costs him nothing.
    if public.suggest_kit_fine(v_issue, 'returned_reusable') <> 0 then
      raise exception '0432 FAILED: a reusable return suggests a fine.';
    end if;

    -- Unusable, issued today, received NEW: nearly the full replacement.
    v_fine := public.suggest_kit_fine(v_issue, 'returned_unusable');
    if v_fine <= 0 or v_fine > 2000 then
      raise exception '0432 FAILED: an unusable return suggests %, outside 0..2000.', v_fine;
    end if;

    -- AND THE CONDITION HE RECEIVED IT IN CHANGES IT. Hand it on at rough and
    -- the next man's suggestion must be lower — he did not cause that wear.
    insert into public.kit_events
      (company_id, event, issue_id, item_type_id, size, grade, quantity,
       from_employee_id, to_employee_id, condition, received_condition,
       unit_actual_cost, event_date)
    select v_co, 'handover', v_issue, v_t, 'L', 'new', 1, v_g, e2.id, 'rough', 'rough', 900, current_date
      from public.employees e2 where e2.company_id = v_co and e2.id <> v_g limit 1;

    if public.suggest_kit_fine(v_issue, 'returned_unusable') >= v_fine then
      raise exception '0432 FAILED: after a rough handover the suggestion did not fall. The receiving guard is being charged for wear that was already there.';
    end if;

    raise exception 'ROLLBACK_PROBE';
  exception
    when others then
      if sqlerrm <> 'ROLLBACK_PROBE' then raise; end if;
      raise notice '0432: probe passed — replacement not actual, reusable free, and the received condition lowers the suggestion.';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- THE TENANT GUARD ASSERTION. NOT OPTIONAL.
-- ---------------------------------------------------------------------------
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0432 REFUSED: tenant_guard_gaps() reports % gap(s): %.', v_n, v_who;
  end if;
end $$;
