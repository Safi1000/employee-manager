-- 0550 — a sales tax rate is locked, and changes on a date
--
-- DECIDED 2026-10-22 (Shayan): "FBR 15% and PRA 16% lock it and any change in
-- it should be dated usually happens once a year when budget comes but in some
-- special cases mid year."
--
-- 0549 kept one editable rate per authority. That is replaced by a dated
-- history: sales_tax_rates holds each rate with the day it took effect and why.
-- A rate is never edited — a change is a new row from its date. The rate a
-- return uses is the one in force on its due date (the 15th); each line also
-- keeps the rate it was filed at, so nothing already filed is rewritten.
--
--   * Seeded: FBR 15% and PRA 16% from 1 July 2026 (the FY 2026-27 budget),
--     the two rates Shayan entered on 22 Oct. AJK has no rate yet.
--   * change_sales_tax_rate(company, code, rate, effective_from, reason)
--     replaces set_sales_tax_rate. It refuses a date on or before the due date
--     of a return already turned into a challan for that authority — that
--     return used the old rate and moving the date under it would contradict it.
--   * set_sales_tax_return_line reads sales_tax_rate_on(…, due_on) — surgery
--     on its one anchor (0549 is its only author).
--   * sales_tax_authorities.rate is dropped: a second copy of the rate is
--     where the two would disagree.
--
-- Asserted, in a block rolled back by a sentinel: the rates in force on
-- 15 Nov 2026; a change from 1 July 2027 applies on 15 July 2027 and not on
-- 15 June 2027; a line takes the rate in force on its return's due date; a
-- change dated under a challan is refused with its message; a change without
-- a reason is refused.

create table if not exists public.sales_tax_rates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id),
  code           text not null check (code in ('PRA', 'FBR', 'AJK')),
  rate           numeric not null check (rate > 0 and rate < 100),
  effective_from date not null,
  reason         text not null check (length(btrim(reason)) >= 5),
  set_by         uuid,
  set_at         timestamptz not null default now(),
  unique (company_id, code, effective_from)
);
comment on table public.sales_tax_rates is
  'DECIDED 2026-10-22 (0550). Sales tax rates, locked and dated: a change is a new row from the day it takes effect '
  '(usually 1 July, with the budget; sometimes mid-year), never an edit. A return uses the rate in force on its due date.';

alter table public.sales_tax_rates enable row level security;
drop policy if exists company_members_read on public.sales_tax_rates;
create policy company_members_read on public.sales_tax_rates for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.sales_tax_rates;
create policy ssa_read on public.sales_tax_rates for select using ((select public.is_ssa_unscoped()));
drop trigger if exists trg_zzz_sales_tax_rates_audit on public.sales_tax_rates;
create trigger trg_zzz_sales_tax_rates_audit after insert or delete or update on public.sales_tax_rates
  for each row execute function public.log_audit_change();
revoke insert, update, delete on public.sales_tax_rates from anon, authenticated;
grant select on public.sales_tax_rates to authenticated;

-- Seed from what 0549's single rate holds today (FBR 15, PRA 16 for GGS).
do $seed$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sales_tax_authorities' and column_name = 'rate') then
    execute $q$
      insert into public.sales_tax_rates (company_id, code, rate, effective_from, reason)
      select a.company_id, a.code, a.rate, date '2026-07-01',
             'FY 2026-27 rate (budget, 1 July 2026), entered by Shayan on 22 Oct 2026 and locked by 0550'
        from public.sales_tax_authorities a
       where a.rate is not null
      on conflict (company_id, code, effective_from) do nothing
    $q$;
  end if;
end $seed$;

create or replace function public.sales_tax_rate_on(p_company_id uuid, p_code text, p_on date)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return (select r.rate from public.sales_tax_rates r
           where r.company_id = p_company_id and r.code = p_code and r.effective_from <= p_on
           order by r.effective_from desc limit 1);
end $function$;

drop function if exists public.set_sales_tax_rate(uuid, text, numeric);

create or replace function public.change_sales_tax_rate(
  p_company_id uuid, p_code text, p_rate numeric, p_effective_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid; v_due date;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if p_code not in ('PRA', 'FBR', 'AJK') then
    raise exception 'Choose PRA, FBR or AJK. Nothing has been changed.' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 or p_rate >= 100 then
    raise exception 'Enter the rate as a percent, more than 0 and less than 100. Nothing has been changed.' using errcode = '23514';
  end if;
  if p_effective_from is null then
    raise exception 'Say from which date the new rate applies. Nothing has been changed.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Say why the rate changed — e.g. "Budget FY 2027-28". Nothing has been changed.' using errcode = '23514';
  end if;
  select max(due_on) into v_due from public.sales_tax_returns
   where company_id = p_company_id and authority = p_code and status in ('posted', 'paid') and due_on >= p_effective_from;
  if v_due is not null then
    raise exception 'A % challan due % was already made at the old rate. A change can only start after it. Nothing has been changed.',
      p_code, to_char(v_due, 'DD Mon YYYY') using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales_tax_rates where company_id = p_company_id and code = p_code and effective_from = p_effective_from) then
    raise exception 'A % rate already starts on %. Nothing has been changed.', p_code, to_char(p_effective_from, 'DD Mon YYYY') using errcode = '23505';
  end if;
  insert into public.sales_tax_rates (company_id, code, rate, effective_from, reason, set_by)
  values (p_company_id, p_code, p_rate, p_effective_from, btrim(p_reason), auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

revoke all on function public.change_sales_tax_rate(uuid, text, numeric, date, text) from public, anon;
grant execute on function public.change_sales_tax_rate(uuid, text, numeric, date, text) to authenticated;
revoke all on function public.sales_tax_rate_on(uuid, text, date) from public, anon;
grant execute on function public.sales_tax_rate_on(uuid, text, date) to authenticated;

-- set_sales_tax_return_line: the rate in force on the return's due date.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.set_sales_tax_return_line(uuid, uuid, date, numeric, text)'::regprocedure);
  v_anchor constant text :=
    E'  select rate into v_rate from public.sales_tax_authorities where company_id = r.company_id and code = r.authority;\n' ||
    E'  if v_rate is null then\n' ||
    E'    raise exception ''Enter the % rate first. Nothing has been recorded.'', r.authority using errcode = ''P0001'';\n' ||
    E'  end if;\n';
  v_n int;
begin
  if position('0550: the rate in force' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0550 REFUSED: the anchor appears % times in set_sales_tax_return_line, expected once.', v_n;
  end if;
  v_def := replace(v_def, v_anchor,
    E'  -- 0550: the rate in force on the return''s due date — dated, never edited.\n' ||
    E'  v_rate := public.sales_tax_rate_on(r.company_id, r.authority, r.due_on);\n' ||
    E'  if v_rate is null then\n' ||
    E'    raise exception ''No % rate is in force on %. Set it, with the date it applies from, first. Nothing has been recorded.'',\n' ||
    E'      r.authority, to_char(r.due_on, ''DD Mon YYYY'') using errcode = ''P0001'';\n' ||
    E'  end if;\n');
  execute v_def;
end $surgery$;

alter table public.sales_tax_authorities drop column if exists rate;
comment on table public.sales_tax_authorities is
  'DECIDED 2026-10-22 (0549). The sales tax authorities a client can file with. Their rates are dated in '
  'sales_tax_rates (0550), not here.';

-- ── asserts ───────────────────────────────────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_cl uuid; v_ret uuid; v_before text; v_n_before int;
begin
  if public.sales_tax_rate_on(v_co, 'FBR', '2026-11-15') is distinct from 15
     or public.sales_tax_rate_on(v_co, 'PRA', '2026-11-15') is distinct from 16 then
    raise exception '0550 REFUSED: FBR/PRA in force on 15 Nov 2026 are %/%, expected 15/16.',
      public.sales_tax_rate_on(v_co, 'FBR', '2026-11-15'), public.sales_tax_rate_on(v_co, 'PRA', '2026-11-15');
  end if;
  if exists (select 1 from public.tenant_guard_gaps() where function_name in ('sales_tax_rate_on', 'change_sales_tax_rate')) then
    raise exception '0550 REFUSED: tenant_guard_gaps names a rate function.';
  end if;
  if exists (select 1 from public.sales_tax_returns where status <> 'draft') then
    raise notice '0550: challans already exist — proof skipped on replay.';
    return;
  end if;

  select id into v_cl from public.clients where company_id = v_co and name = 'Emaar DHA ISB';
  select sales_tax_authority into v_before from public.clients where id = v_cl;
  select count(*) into v_n_before from public.sales_tax_returns;
  begin
    perform public.change_sales_tax_rate(v_co, 'FBR', 18, '2027-07-01', 'proof — budget FY 2027-28');
    if public.sales_tax_rate_on(v_co, 'FBR', '2027-07-15') <> 18 or public.sales_tax_rate_on(v_co, 'FBR', '2027-06-15') <> 15 then
      raise exception '0550 REFUSED: a change from 1 Jul 2027 did not split June and July correctly.';
    end if;
    begin
      perform public.change_sales_tax_rate(v_co, 'FBR', 17, '2027-08-01', 'no');
      raise exception '0550 REFUSED: a change without a reason was accepted.';
    exception when others then
      if sqlerrm not like 'Say why the rate changed%' then raise; end if;
    end;

    update public.clients set sales_tax_authority = 'FBR' where id = v_cl;
    v_ret := public.open_sales_tax_return(v_co, 'FBR', '2027-01-15');
    perform public.set_sales_tax_return_line(v_ret, v_cl, '2026-09-01', 10000, 'proof');  -- a reached month: no journal posts to the future
    if (select rate from public.sales_tax_return_lines where return_id = v_ret) <> 15 then
      raise exception '0550 REFUSED: the line took a rate other than the 15%% in force on 15 Jan 2027.';
    end if;
    perform public.post_sales_tax_return(v_ret, 1500);
    begin
      perform public.change_sales_tax_rate(v_co, 'FBR', 17, '2027-01-01', 'proof — under a challan');
      raise exception '0550 REFUSED: a change dated under a challan was accepted.';
    exception when others then
      if sqlerrm not like 'A FBR challan due 15 Jan 2027 was already made at the old rate.%' then raise; end if;
    end;
    raise exception '0550-SENTINEL';
  exception when others then
    if sqlerrm <> '0550-SENTINEL' then raise; end if;
  end;
  if (select count(*) from public.sales_tax_returns) <> v_n_before or exists (select 1 from public.sales_tax_rates where reason like 'proof%')
     or (select sales_tax_authority from public.clients where id = v_cl) is distinct from v_before then
    raise exception '0550 REFUSED: the proof survived its rollback.';
  end if;
  raise notice '0550: rates locked and dated — FBR 15%%, PRA 16%% from 1 Jul 2026.';
end $mig$;
