-- 0329 — archiving a company makes its records read-only, enforced where the
-- writes actually happen.
--
-- WHY NOT companies.active
--
-- `active` already exists and is genuinely unreferenced by RLS — 0 of 272
-- policies mention it, and current_company_id() does not consult it. It is
-- still the wrong column, because it is not unused:
--
--   RequireAuth.tsx:35   if (company.active === false || expired) -> BLOCKS LOGIN
--   Companies.tsx        the super-super-admin toggle, labelled Active/Suspended
--   enforce_subscription_expiry, add_subscription_payment, and seven views
--
-- It is the billing SUSPENSION flag, and suspension stops sign-in. Archiving
-- through it would make the company's data unviewable rather than read-only,
-- which is deletion with extra steps and the opposite of the point.
--
-- archived_at is a timestamptz rather than a boolean because "when was this
-- archived" is the first question anyone asks, and a boolean cannot answer it.
-- Free now, impossible to retrofit.
--
-- WHY A TRIGGER AND NOT AN RLS POLICY. THIS IS THE WHOLE DESIGN.
--
-- Measured on production before writing:
--
--   tables carrying company_id ................. 129
--   of those, RLS enabled ...................... 129
--   of those, FORCE ROW LEVEL SECURITY ..........  0
--   table owner ................................. postgres
--   SECURITY DEFINER functions in public ....... 282
--
-- A SECURITY DEFINER function runs as its owner, postgres, which OWNS these
-- tables. Without FORCE ROW LEVEL SECURITY, RLS does not apply to the owner. So
-- an archive flag written as a policy would bind on direct PostgREST table
-- writes and be silently ignored by all 282 RPCs — post_journal,
-- record_invoice_payment, post_payslip_disbursement, every posting path — which
-- is how this application actually writes.
--
-- A policy the real write path bypasses is worse than no policy, because it
-- looks enforced. A BEFORE row trigger fires for every caller: PostgREST, RPC,
-- psql, pg_cron, and a migration. enforce_period_lock already works this way.
--
-- NO EXEMPTIONS, INCLUDING audit_log.
--
-- An archive with exceptions is a policy, not a boundary, and two exceptions on
-- day one make it negotiable for ever. The audit row for the archiving is
-- written BEFORE archived_at is set: the act of archiving is the last thing
-- that happens to a company, and it records itself on the way past.
--
-- ARCHIVING MAKES A COMPANY UNDELETABLE, DELIBERATELY.
--
-- `delete from companies` cascades into these 129 tables, and those cascaded
-- deletes are writes, so the trigger refuses them. Removal therefore takes two
-- deliberate acts: un-archive, then delete. That is a feature — the guards n
-- guides delete was authorised twice, rehearsed, and still aborted once on a
-- stale assertion — and the trigger says so in its own message, because that is
-- what someone needs to read at the moment they hit it, not in a document.
--
-- READS ARE UNTOUCHED. No RLS change, no change to current_company_id(), no
-- change to RequireAuth. An archived company still opens, still shows its
-- ledger, still exports. The tempting one-liner — make current_company_id()
-- return null when archived — was rejected: it makes the data INVISIBLE rather
-- than read-only, and it breaks assert_same_company for that tenant, so every
-- guarded function starts refusing reads too. Read and write are different
-- questions and this flag answers only the second.

alter table public.companies
  add column if not exists archived_at timestamptz;

comment on column public.companies.archived_at is
  'When this company was archived (0329). Non-null makes every company-scoped table read-only via trg_company_not_archived — enforced by trigger, not RLS, because SECURITY DEFINER functions run as the table owner and bypass RLS entirely. NOT the same as `active`, which is billing suspension and blocks login. Archiving keeps the data readable. A company must be un-archived before it can be deleted.';

-- ---------------------------------------------------------------------------
-- The guard.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_company_not_archived()
returns trigger
language plpgsql
as $function$
declare
  v_company  uuid;
  v_archived timestamptz;
  v_name     text;
  v_row      jsonb;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_company := (v_row ->> 'company_id')::uuid;

  -- A row with no company belongs to no tenant and this rule has nothing to say
  -- about it. Returning here is not a fall-through: company_id is nullable on a
  -- few tables and null means "not company-scoped", not "unknown".
  if v_company is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select c.archived_at, c.name into v_archived, v_name
    from public.companies c where c.id = v_company;

  if v_archived is not null then
    if tg_op = 'DELETE' then
      raise exception
        '% is archived (since %) and its records are read-only. Un-archive it before deleting — removal takes two deliberate acts by design. [%]',
        coalesce(v_name, v_company::text), v_archived::date, tg_table_name
        using errcode = 'P0001',
              hint = 'update public.companies set archived_at = null where id = ''' || v_company || ''';';
    end if;
    raise exception
      '% is archived (since %) and its records are read-only. Un-archive it before writing to it. [%]',
      coalesce(v_name, v_company::text), v_archived::date, tg_table_name
      using errcode = 'P0001',
            hint = 'update public.companies set archived_at = null where id = ''' || v_company || ''';';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

comment on function public.enforce_company_not_archived() is
  '0329. Refuses INSERT/UPDATE/DELETE on any row belonging to a company with archived_at set. A TRIGGER rather than an RLS policy because SECURITY DEFINER functions run as the table owner and RLS does not apply to the owner (no table here sets FORCE ROW LEVEL SECURITY), so a policy would be bypassed by all 282 of them.';

-- ---------------------------------------------------------------------------
-- Attached to every company-scoped table, GENERATED rather than listed.
--
-- A hand-listed set is how a table gets missed, and the one that gets missed is
-- the one nobody thinks about. Not attached to `companies` itself — it has no
-- company_id column, and putting it there would make archiving impossible to
-- undo.
-- ---------------------------------------------------------------------------
do $attach$
declare
  r     record;
  v_n   int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname <> 'companies'
       and exists (select 1 from information_schema.columns col
                    where col.table_schema = 'public'
                      and col.table_name = c.relname
                      and col.column_name = 'company_id')
     order by 1
  loop
    execute format('drop trigger if exists trg_company_not_archived on public.%I', r.relname);
    execute format(
      'create trigger trg_company_not_archived before insert or update or delete on public.%I '
      'for each row execute function public.enforce_company_not_archived()', r.relname);
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    raise exception '0329 FAILED: no company-scoped tables were found — the loop matched nothing';
  end if;
  raise notice '0329: trigger attached to % company-scoped tables', v_n;
end
$attach$;

-- ---------------------------------------------------------------------------
-- PROOF
--
--   A. COVERAGE, as a property rather than a number. Every table with a
--      company_id column carries the trigger — asserted as "0 without it", not
--      as "129 with it", so the assertion cannot pass by matching a stale count
--      after a table is added or dropped.
--   B. A write is REFUSED when the company is archived and ACCEPTED when it is
--      not. Both halves: a trigger that refuses everything passes a test that
--      only checks refusal (report 9.11).
--   C. The refusal fires INSIDE A SECURITY DEFINER FUNCTION. This is the
--      assertion the whole design exists for. Without it the trigger is only
--      proved on the path an RLS policy would already have covered, and the
--      argument for choosing a trigger is untested.
--   D. DELETE is refused too, with the message that names the way out, because
--      that is the case someone will meet while trying to remove a company.
--   E. Un-archiving restores writes — the flag is reversible, not a one-way
--      door.
--
-- All of it inside a subtransaction that unwinds through a deliberate raise
-- (0321). Nothing is left archived and no row survives.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co        uuid;
  v_name      text;
  v_missing   int;
  v_tables    int;
  v_loc       uuid;
  v_acct      uuid;
  v_outcome   text;
  v_stage     text := 'not started';
  v_live_ok   boolean := false;
  v_refused   text;
  v_definer   text;
  v_del       text;
  v_restored  boolean := false;
begin
  -- A. coverage
  select count(*) into v_tables
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname <> 'companies'
     and exists (select 1 from information_schema.columns col
                  where col.table_schema='public' and col.table_name=c.relname
                    and col.column_name='company_id');

  select count(*) into v_missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname <> 'companies'
     and exists (select 1 from information_schema.columns col
                  where col.table_schema='public' and col.table_name=c.relname
                    and col.column_name='company_id')
     and not exists (select 1 from pg_trigger t
                      where t.tgrelid = c.oid and t.tgname = 'trg_company_not_archived'
                        and not t.tgisinternal);
  if v_missing <> 0 then
    raise exception '0329 FAILED: % of % company-scoped tables have no trigger', v_missing, v_tables;
  end if;

  -- Pick the company with the least attached to it, so the probe is cheap.
  select c.id, c.name into v_co, v_name
    from public.companies c
   order by (select count(*) from public.employees e where e.company_id = c.id)
   limit 1;
  if v_co is null then
    raise exception '0329 FAILED: no company to prove against';
  end if;

  begin
    -- B(i). LIVE: the write is accepted.
    insert into public.locations (company_id, name) values (v_co, '0329 probe location')
      returning id into v_loc;
    v_live_ok := (v_loc is not null);
    if not v_live_ok then
      v_stage := 'a write to a LIVE company did not land';
      raise exception 'STAGE_FAILED';
    end if;

    -- Remove the account the SECURITY DEFINER probe (C) needs to create, while
    -- the company is still writable.
    delete from public.chart_of_accounts
     where company_id = v_co and system_key = 'unearned_revenue';

    -- Archive it.
    update public.companies set archived_at = now() where id = v_co;

    -- B(ii). ARCHIVED: the same write is refused.
    v_refused := null;
    begin
      insert into public.locations (company_id, name) values (v_co, '0329 probe blocked');
      v_refused := 'ACCEPTED';
    exception when others then v_refused := sqlerrm;
    end;
    if v_refused = 'ACCEPTED' then
      v_stage := 'an INSERT was accepted for an ARCHIVED company';
      raise exception 'STAGE_FAILED';
    end if;
    if position('read-only' in v_refused) = 0 then
      v_stage := format('the INSERT was refused for the wrong reason: %s', v_refused);
      raise exception 'STAGE_FAILED';
    end if;

    -- C. THE POINT: a SECURITY DEFINER function is refused too. It runs as
    --    postgres, which owns the table, so RLS would not have stopped it.
    v_definer := null;
    begin
      v_acct := public.ensure_unearned_revenue_account(v_co);
      v_definer := 'ACCEPTED';
    exception when others then v_definer := sqlerrm;
    end;
    if v_definer = 'ACCEPTED' then
      v_stage := 'a SECURITY DEFINER function wrote to an ARCHIVED company — the trigger does not cover the path this design exists for';
      raise exception 'STAGE_FAILED';
    end if;
    if position('read-only' in v_definer) = 0 then
      v_stage := format('the SECURITY DEFINER write was refused for the wrong reason: %s', v_definer);
      raise exception 'STAGE_FAILED';
    end if;

    -- D. DELETE is refused, and the message names the way out.
    v_del := null;
    begin
      delete from public.locations where id = v_loc;
      v_del := 'ACCEPTED';
    exception when others then v_del := sqlerrm;
    end;
    if v_del = 'ACCEPTED' then
      v_stage := 'a DELETE was accepted for an ARCHIVED company';
      raise exception 'STAGE_FAILED';
    end if;
    if position('Un-archive it before deleting' in v_del) = 0 then
      v_stage := format('the DELETE refusal does not tell the reader how to proceed: %s', v_del);
      raise exception 'STAGE_FAILED';
    end if;

    -- E. Un-archiving restores writes.
    update public.companies set archived_at = null where id = v_co;
    begin
      delete from public.locations where id = v_loc;
      v_restored := true;
    exception when others then v_restored := false;
    end;
    if not v_restored then
      v_stage := 'writes did not come back after un-archiving — the flag is a one-way door';
      raise exception 'STAGE_FAILED';
    end if;

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome = 'STAGE_FAILED' then
    raise exception '0329 FAILED: %', v_stage;
  end if;
  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0329 FAILED at "%": %', v_stage, v_outcome;
  end if;

  -- and it unwound: nothing archived, no probe row, the account back.
  if exists (select 1 from public.companies where archived_at is not null) then
    raise exception '0329 FAILED: a company is still archived after the probe';
  end if;
  if exists (select 1 from public.locations where name like '0329 probe%') then
    raise exception '0329 FAILED: a probe row survived the rollback';
  end if;
  if not exists (select 1 from public.chart_of_accounts
                  where company_id = v_co and system_key = 'unearned_revenue') then
    raise exception '0329 FAILED: the unearned_revenue account did not come back — the probe did not unwind';
  end if;

  raise notice
    '0329 OK: % company-scoped tables carry the trigger; a write is accepted live and refused when archived, INCLUDING from a SECURITY DEFINER function; DELETE is refused with the way out named; un-archiving restores writes; the probe unwound',
    v_tables;
end
$proof$;
