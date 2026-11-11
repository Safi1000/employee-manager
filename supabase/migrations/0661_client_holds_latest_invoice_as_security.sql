-- 0661 — a client that holds its latest invoice as security: shown as held, not as owed late
--
-- Asked 11 Nov 2026 (Shayan): HMC keeps one invoice unpaid as security in
-- place of a PKR 5m bank guarantee. It rolls: "every month the previous
-- invoice is released, the latest invoice is held." Anything older still
-- unpaid is real arrears ("some excess receivables as well other than
-- security"). Receivables counted the held invoice like any other, so ageing
-- and receivable days overstated what HMC owes in the ordinary way.
--
-- DECIDED 11 Nov 2026 (Shayan, option a): DISPLAY ONLY. The held invoice stays
-- a receivable at full value: no journal, no retention account, the client's
-- balance unchanged. What changes is the reading: the client's newest invoice
-- leaves the age buckets, overdue, open invoices, oldest open date and
-- receivable days, and is reported on its own as "held as security". (The
-- other way, if it is ever wanted: a 1150 Retention Receivable reclass posted
-- each month for the held invoice; this table would still say which client
-- and why.)
--
-- Why a client setting and not a mark on an invoice: HMC's cheques are mostly
-- recorded against the client, not an invoice, so the per-invoice "unpaid"
-- figure is not what the client owes on it (September shows 4.69m unpaid on
-- its own record while oldest-first it is all but 147,263 settled). And the
-- held invoice changes every month. "The newest invoice is held" follows both
-- without anyone moving a mark.
--
-- The change:
--   1. client_security_holds — client, reason, since, who set it and when; and
--      who ended it, when, and why. One open per client.
--   2. set_client_security_hold(client, reason, since) /
--      end_client_security_hold(hold, note) — invoices.edit; reasons required.
--   3. client_receivables_base() by surgery (five authors: 0628–0645): for a
--      client with an open hold, its newest invoice (by the same order the
--      oldest-first allocation uses) is moved out of the ordinary rows, so it
--      is in no age bucket, not overdue, not counted open, not the oldest. The
--      allocation itself is unchanged, so balance and every other invoice's
--      remainder are exactly what they were. Return shape unchanged —
--      client_followup_list reads it with select *.
--   4. client_security_held() — per client on hold: the held invoice and what
--      is still unpaid on it (balance less the aged rows, read from the base),
--      reason and since.
--   5. regional_receivables_aging by surgery: the held invoice leaves open_inv,
--      so it is in neither the buckets nor dso_weighted_days.
--
-- Asserted on what can break, on HMC Taxila inside a block rolled back by a
-- sentinel: setting the hold moves exactly the October invoice's unpaid amount
-- out of the aged total and into client_security_held(), leaves the balance
-- and the overdue figure where they were, and drops open invoices by one;
-- ending it puts every figure back.

create table if not exists public.client_security_holds (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id),
  client_id   uuid not null references public.clients(id),
  reason      text not null check (btrim(reason) <> ''),
  since       date not null,
  set_by      uuid default auth.uid(),
  set_at      timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    uuid,
  end_note    text
);
create unique index if not exists client_security_holds_one_open
  on public.client_security_holds (client_id) where ended_at is null;
create index if not exists client_security_holds_company_idx on public.client_security_holds (company_id);

comment on table public.client_security_holds is
  '0661: a client that holds its LATEST invoice as security (rolling; e.g. HMC in place of a bank guarantee). DECIDED '
  '11 Nov 2026 (Shayan): display only — still a receivable at full value; the newest invoice leaves ageing, overdue and '
  'receivable days and is shown as held as security. Written only by set_client_security_hold / end_client_security_hold.';

alter table public.client_security_holds enable row level security;
revoke all on public.client_security_holds from anon, authenticated;
grant select on public.client_security_holds to authenticated;

drop policy if exists company_members on public.client_security_holds;
create policy company_members on public.client_security_holds for select
  using (company_id = (select public.current_company_id()));
drop policy if exists ssa_all on public.client_security_holds;
create policy ssa_all on public.client_security_holds for select
  using ((select public.is_ssa_unscoped()));
drop policy if exists branch_scope on public.client_security_holds;
create policy branch_scope on public.client_security_holds as restrictive for select
  using ((not (select public.is_branched_user())) or (select public.is_super_super_admin())
         or exists (select 1 from public.clients c
                     where c.id = client_security_holds.client_id and c.branch_id = (select public.current_branch_id())));
drop policy if exists perm_read on public.client_security_holds;
create policy perm_read on public.client_security_holds as restrictive for select
  using ((select public.has_perm('invoices.view')) or (select public.has_perm('invoices.edit'))
         or (select public.has_perm('receivables.view')) or (select public.has_perm('accounting.edit'))
         or (select public.has_perm('reports.view')) or (select public.has_perm('accountant.view')));

create or replace function public.set_client_security_hold(p_client_id uuid, p_reason text, p_since date)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare c public.clients; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  if p_client_id is not null then
    perform public.assert_same_company((select company_id from public.clients where id = p_client_id));
  end if;
  select * into c from public.clients where id = p_client_id;
  if c.id is null then raise exception 'That client does not exist. Nothing has been recorded.'; end if;
  perform public.assert_branch_writable(c.branch_id);
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Say why the client holds an invoice (e.g. in place of a bank guarantee). Nothing has been recorded.';
  end if;
  if p_since is null then raise exception 'Say since when. Nothing has been recorded.'; end if;
  if exists (select 1 from public.client_security_holds h where h.client_id = c.id and h.ended_at is null) then
    raise exception '% already holds its latest invoice as security. Nothing has been recorded.', c.name;
  end if;
  insert into public.client_security_holds (company_id, client_id, reason, since)
  values (c.company_id, c.id, btrim(p_reason), p_since)
  returning id into v_id;
  return v_id;
end $function$;
comment on function public.set_client_security_hold(uuid, text, date) is
  '0661: the client holds its latest invoice as security (rolling). Display only: that invoice leaves ageing, overdue '
  'and receivable days; the ledger and the client balance are unchanged.';
revoke all on function public.set_client_security_hold(uuid, text, date) from public, anon;
grant execute on function public.set_client_security_hold(uuid, text, date) to authenticated;

create or replace function public.end_client_security_hold(p_hold_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare h public.client_security_holds; v_branch uuid; v_n int;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('invoices.edit'); end if;
  if p_hold_id is not null then
    perform public.assert_same_company((select company_id from public.client_security_holds where id = p_hold_id));
  end if;
  select * into h from public.client_security_holds where id = p_hold_id for update;
  if h.id is null then raise exception 'That security arrangement does not exist. Nothing has been recorded.'; end if;
  select branch_id into v_branch from public.clients where id = h.client_id;
  perform public.assert_branch_writable(v_branch);
  if h.ended_at is not null then raise exception 'This security arrangement has already ended. Nothing has been recorded.'; end if;
  if nullif(btrim(p_note), '') is null then
    raise exception 'Say why it ended (e.g. contract ended, security released). Nothing has been recorded.';
  end if;
  update public.client_security_holds
     set ended_at = now(), ended_by = auth.uid(), end_note = btrim(p_note)
   where id = h.id and ended_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'The security arrangement could not be ended. Nothing has been recorded.'; end if;
end $function$;
comment on function public.end_client_security_hold(uuid, text) is
  '0661: the client no longer holds an invoice as security (note required); its newest invoice ages again.';
revoke all on function public.end_client_security_hold(uuid, text) from public, anon;
grant execute on function public.end_client_security_hold(uuid, text) to authenticated;

-- 3. client_receivables_base — surgery against the live definition.
do $mig$
declare
  v_def text; v_n int; cnt int;
  a1 constant text := E'  items as (\n';
  b1 constant text := E'  held as (\n'
    || E'    -- 0661: a client on a security hold holds its NEWEST invoice — the last in the\n'
    || E'    -- order the allocation below uses. It is kept out of the ordinary rows (ord 2),\n'
    || E'    -- so it is in no age bucket; the allocation and the balance are untouched.\n'
    || E'    select distinct on (i.client_id) i.client_id as cid, i.id as invoice_id\n'
    || E'      from public.invoices i\n'
    || E'      join public.client_security_holds s on s.client_id = i.client_id and s.ended_at is null\n'
    || E'     order by i.client_id, i.invoice_date desc, i.id desc\n'
    || E'  ),\n'
    || E'  items as (\n';
  a2 constant text := E'    select cid, ord, d, greatest(0, least(amt, cum - paid_total)) as remaining\n      from alloc\n';
  b2 constant text := E'    select cid,\n'
    || E'           case when ord = 1 and exists (select 1 from held hh where hh.invoice_id = alloc.invoice_id) then 2 else ord end as ord,\n'
    || E'           d, greatest(0, least(amt, cum - paid_total)) as remaining\n      from alloc\n';
begin
  v_def := pg_get_functiondef('public.client_receivables_base()'::regprocedure);
  if position('client_security_holds' in v_def) > 0 then
    raise notice '0661: client_receivables_base already amended.';
  else
    cnt := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
    if cnt <> 1 then raise exception '0661 REFUSED: client_receivables_base anchor 1 appears % times, expected 1.', cnt; end if;
    cnt := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
    if cnt <> 1 then raise exception '0661 REFUSED: client_receivables_base anchor 2 appears % times, expected 1.', cnt; end if;
    execute replace(replace(v_def, a1, b1), a2, b2);
  end if;
end $mig$;

-- 4. What is held, per client. Reads the base: held = balance less the aged rows.
create or replace function public.client_security_held()
returns table(hold_id uuid, client_id uuid, client_name text, reason text, since date,
              invoice_id uuid, invoice_number text, invoice_date date, period_start date,
              invoice_amount numeric, held_amount numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- 0661. Definer only so it can read the base like client_receivables_today();
  -- the same amount and region filters are applied here.
  with t as (
    select b.client_id, b.client_name, b.balance,
           b.owed_before_bastion + b.age_0_30 + b.age_31_60 + b.age_61_90 + b.age_over_90 as aged
      from public.client_receivables_today() b
  ),
  latest as (
    select distinct on (i.client_id) i.client_id, i.id, i.invoice_number, i.invoice_date, i.period_start, i.invoice_amount
      from public.invoices i
     order by i.client_id, i.invoice_date desc, i.id desc
  )
  select h.id, h.client_id, t.client_name, h.reason, h.since,
         l.id, l.invoice_number, l.invoice_date, l.period_start, l.invoice_amount,
         greatest(0, least(coalesce(l.invoice_amount, 0), t.balance - t.aged))
    from public.client_security_holds h
    join t on t.client_id = h.client_id
    left join latest l on l.client_id = h.client_id
   where h.ended_at is null
     and h.company_id = public.current_company_id()
$function$;
comment on function public.client_security_held() is
  '0661: clients holding their latest invoice as security, which invoice that is, and what is still unpaid on it.';
revoke all on function public.client_security_held() from public, anon;
grant execute on function public.client_security_held() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('client_security_held', array['invoices.view','invoices.edit','receivables.view','accounting.edit'], 'Receivables (same keys as can_see_receivable_amounts)')
on conflict (function_name) do update set any_of = excluded.any_of, reason = excluded.reason;

-- 5. regional_receivables_aging — surgery against the live view.
do $mig$
declare
  v_def text; cnt int;
  a constant text := 'WHERE ((COALESCE(i.status, ''''::text) <> ''Written-Off''::text) AND';
  b constant text := 'WHERE (NOT (i.id IN ( SELECT DISTINCT ON (ii.client_id) ii.id FROM (invoices ii JOIN client_security_holds s ON (((s.client_id = ii.client_id) AND (s.ended_at IS NULL)))) ORDER BY ii.client_id, ii.invoice_date DESC, ii.id DESC))) AND ((COALESCE(i.status, ''''::text) <> ''Written-Off''::text) AND';
begin
  v_def := pg_get_viewdef('public.regional_receivables_aging'::regclass);
  if position('client_security_holds' in v_def) > 0 then
    raise notice '0661: regional_receivables_aging already amended.';
  else
    cnt := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
    if cnt <> 1 then raise exception '0661 REFUSED: regional_receivables_aging anchor appears % times, expected 1.', cnt; end if;
    execute 'create or replace view public.regional_receivables_aging with (security_invoker = true) as ' || replace(v_def, a, b);
  end if;
end $mig$;

-- Asserted on what can break.
do $mig$
declare
  v_client uuid; v_company uuid; v_latest record; v_hold uuid; v_ok boolean := false;
  b0 record; b1 record; b2 record; v_held record; v_user uuid;
begin
  select c.id, c.company_id into v_client, v_company from public.clients c where c.name = 'HMC Taxila';
  if v_client is null or exists (select 1 from public.client_security_holds h where h.client_id = v_client and h.ended_at is null) then
    raise notice '0661: HMC Taxila is missing or already on a security hold; the test is skipped.';
  else
    select i.id, i.invoice_number into v_latest from public.invoices i
     where i.client_id = v_client order by i.invoice_date desc, i.id desc limit 1;
    -- The base reads current_company_id(), which needs a user: run as a super
    -- admin of HMC's company (the claim is local to the rolled-back block).
    select p.id into v_user from public.profiles p
     where coalesce(p.view_as_company, p.company_id) = v_company and p.role = 'super_admin'
     order by p.id limit 1;
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
      select balance, owed_before_bastion + age_0_30 + age_31_60 + age_61_90 + age_over_90 as aged, overdue, open_invoices
        into b0 from public.client_receivables_base() where client_id = v_client;
      if b0.balance is null then raise exception '0661 REFUSED: client_receivables_base() returned no row for HMC.'; end if;

      v_hold := public.set_client_security_hold(v_client, '0661 test', current_date);
      select balance, owed_before_bastion + age_0_30 + age_31_60 + age_61_90 + age_over_90 as aged, overdue, open_invoices
        into b1 from public.client_receivables_base() where client_id = v_client;
      select * into v_held from public.client_security_held() where hold_id = v_hold;

      if abs(b1.balance - b0.balance) > 0.005 then
        raise exception '0661 REFUSED: the hold moved HMC''s balance (% -> %).', b0.balance, b1.balance;
      end if;
      if v_held.invoice_id is distinct from v_latest.id then
        raise exception '0661 REFUSED: the held invoice is %, expected the newest, %.', v_held.invoice_number, v_latest.invoice_number;
      end if;
      if v_held.held_amount is null or abs((b0.aged - b1.aged) - v_held.held_amount) > 0.005 or v_held.held_amount <= 0 then
        raise exception '0661 REFUSED: aged total moved by % but % is shown held.', b0.aged - b1.aged, v_held.held_amount;
      end if;
      if abs(b1.aged + v_held.held_amount - b1.balance) > 0.005 then
        raise exception '0661 REFUSED: aged % + held % does not make the balance %.', b1.aged, v_held.held_amount, b1.balance;
      end if;
      if b1.open_invoices <> b0.open_invoices - 1 then
        raise exception '0661 REFUSED: open invoices % -> %, expected one fewer.', b0.open_invoices, b1.open_invoices;
      end if;

      perform public.end_client_security_hold(v_hold, '0661 test ended');
      select balance, owed_before_bastion + age_0_30 + age_31_60 + age_61_90 + age_over_90 as aged, overdue, open_invoices
        into b2 from public.client_receivables_base() where client_id = v_client;
      if (b2.balance, b2.aged, b2.overdue, b2.open_invoices) is distinct from (b0.balance, b0.aged, b0.overdue, b0.open_invoices) then
        raise exception '0661 REFUSED: ending the hold did not restore HMC''s figures (% vs %).', b2, b0;
      end if;
      v_ok := true;
      raise exception '0661_SENTINEL';
    exception when others then
      if sqlerrm <> '0661_SENTINEL' then raise; end if;
    end;
    if not v_ok then raise exception '0661 REFUSED: the rolled-back test did not complete.'; end if;
  end if;

  if exists (select 1 from public.security_gaps()) then raise exception '0661 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0661 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps()
              where function_name in ('set_client_security_hold', 'end_client_security_hold', 'client_security_held')) then
    raise exception '0661 REFUSED: branch_guard_gaps() reports one of 0661''s functions.';
  end if;
end $mig$;