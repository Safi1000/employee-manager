-- 0551 — EOBI is one dated rate, and each client says who bears it
--
-- DECIDED 2026-10-22 (Shayan):
--   * "2442 per head and 407 employee cont rest employer" — 407 from the
--     guard, 2,035 from the company.
--   * "old rates were 370 then 400 then 407 soo same formula to be applie" —
--     like the sales tax rates (0550): one rate for the company, dated, a
--     change applying from its month, never an edit.
--   * "clients whose guard will be deducted EOBI then we input emp
--     contribution it automatically deducts that from them next month rather
--     than i input eobi deduction in each client one flat rate select who
--     absorbs the costs who doesnt".
--   * Deducted from every guard at an EOBI client, not only those on the
--     challan (asked and answered the same day).
--
-- So:
--   * statutory_rates holds, per scheme, the employee and employer amount
--     per head per month, from a month, with a reason. Seeded: EOBI 407 +
--     2,035 from October 2026 payroll. PESSI and IESSI use the same table
--     (fixed per head, as decided) once their amounts are given.
--   * clients.eobi_bearer: 'employee' (the guard's 407 is deducted; the
--     company bears 2,035), 'company' (nothing is deducted; the company bears
--     the whole 2,442), or null (no EOBI). Backfilled from eobi_enabled: the
--     three clients that deducted (HMC, Emaar, Wusat) are 'employee'.
--   * The per-client and per-contract amounts (clients.eobi_amount,
--     contracts.eobi_amount / eobi_deduction) are superseded — payroll stops
--     reading them — and payroll_statutory_settings.eobi_employer_amount (the
--     amount 0524 waited for) is dropped: the dated rate replaces it.
--   * fill_eobi_employer (0524, its only author) is restated behind a digest
--     precondition: the employer accrual comes from the rate in force for the
--     payslip's month — 2,035 where the guard's share was deducted, 2,442
--     where the company absorbs it.
--
-- Asserted, rolled back by a sentinel: the rate for October; an HMC payslip
-- withholding 407 accrues 2,035; a payslip at a client marked 'company' with
-- nothing withheld accrues 2,442; a change dated under existing payslips is
-- refused with its message.

create table if not exists public.statutory_rates (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  scheme          text not null check (scheme in ('eobi', 'pessi', 'iessi')),
  employee_amount numeric not null check (employee_amount >= 0),
  employer_amount numeric not null check (employer_amount >= 0),
  effective_from  date not null check (effective_from = date_trunc('month', effective_from)::date),
  reason          text not null check (length(btrim(reason)) >= 5),
  set_by          uuid,
  set_at          timestamptz not null default now(),
  unique (company_id, scheme, effective_from)
);
comment on table public.statutory_rates is
  'DECIDED 2026-10-22 (0551). Per head per month, by scheme: what is deducted from the employee and what the company '
  'pays, from a payroll month on. A change is a new row from its month, never an edit (EOBI went 370, 400, 407).';

alter table public.statutory_rates enable row level security;
drop policy if exists company_members_read on public.statutory_rates;
create policy company_members_read on public.statutory_rates for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.statutory_rates;
create policy ssa_read on public.statutory_rates for select using ((select public.is_ssa_unscoped()));
drop trigger if exists trg_zzz_statutory_rates_audit on public.statutory_rates;
create trigger trg_zzz_statutory_rates_audit after insert or delete or update on public.statutory_rates
  for each row execute function public.log_audit_change();
revoke insert, update, delete on public.statutory_rates from anon, authenticated;
grant select on public.statutory_rates to authenticated;

insert into public.statutory_rates (company_id, scheme, employee_amount, employer_amount, effective_from, reason)
values ('7f7899a0-edd2-4491-a40d-f81b54c68d1e', 'eobi', 407, 2035, '2026-10-01',
        '2,442 per head: 407 employee, 2,035 employer (Shayan, 22 Oct 2026) — from October 2026 payroll')
on conflict (company_id, scheme, effective_from) do nothing;

create or replace function public.statutory_rate_on(p_company_id uuid, p_scheme text, p_month date)
returns table(employee_amount numeric, employer_amount numeric, effective_from date)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  return query
  select r.employee_amount, r.employer_amount, r.effective_from
    from public.statutory_rates r
   where r.company_id = p_company_id and r.scheme = p_scheme and r.effective_from <= date_trunc('month', p_month)::date
   order by r.effective_from desc limit 1;
end $function$;

create or replace function public.change_statutory_rate(
  p_company_id uuid, p_scheme text, p_employee_amount numeric, p_employer_amount numeric, p_effective_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
declare v_m date := date_trunc('month', p_effective_from)::date; v_last date; v_id uuid;
begin
  if auth.uid() is not null and pg_trigger_depth() = 0 then perform public.require_perm('accounting.edit'); end if;
  -- tenant guard [claimed]: p_company_id IS the caller's tenant claim
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;
  if p_scheme not in ('eobi', 'pessi', 'iessi') then
    raise exception 'Choose EOBI, PESSI or IESSI. Nothing has been changed.' using errcode = '22023';
  end if;
  if coalesce(p_employee_amount, -1) < 0 or coalesce(p_employer_amount, -1) < 0 or p_employee_amount + p_employer_amount = 0 then
    raise exception 'Enter the employee and employer amounts per head (either may be 0, not both). Nothing has been changed.' using errcode = '23514';
  end if;
  if v_m is null then raise exception 'Say from which payroll month it applies. Nothing has been changed.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Say why it changed — e.g. "Minimum wage FY 2027-28". Nothing has been changed.' using errcode = '23514';
  end if;
  if p_scheme = 'eobi' then
    select max(period_month) into v_last from public.payslips
     where company_id = p_company_id and period_month >= v_m and (coalesce(eobi, 0) > 0 or coalesce(eobi_employer, 0) > 0);
    if v_last is not null then
      raise exception 'Payslips for % already carry EOBI at the old rate. A change can only start after that month. Nothing has been changed.',
        to_char(v_last, 'FMMonth YYYY') using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from public.statutory_rates where company_id = p_company_id and scheme = p_scheme and effective_from = v_m) then
    raise exception 'A % rate already starts in %. Nothing has been changed.', upper(p_scheme), to_char(v_m, 'FMMonth YYYY') using errcode = '23505';
  end if;
  insert into public.statutory_rates (company_id, scheme, employee_amount, employer_amount, effective_from, reason, set_by)
  values (p_company_id, p_scheme, p_employee_amount, p_employer_amount, v_m, btrim(p_reason), auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

revoke all on function public.statutory_rate_on(uuid, text, date) from public, anon;
grant execute on function public.statutory_rate_on(uuid, text, date) to authenticated;
revoke all on function public.change_statutory_rate(uuid, text, numeric, numeric, date, text) from public, anon;
grant execute on function public.change_statutory_rate(uuid, text, numeric, numeric, date, text) to authenticated;

-- ── who bears EOBI, per client ───────────────────────────────────────────────
alter table public.clients add column if not exists eobi_bearer text;
alter table public.clients drop constraint if exists clients_eobi_bearer_check;
alter table public.clients add constraint clients_eobi_bearer_check check (eobi_bearer is null or eobi_bearer in ('employee', 'company'));
update public.clients set eobi_bearer = 'employee' where eobi_enabled and eobi_bearer is null;
comment on column public.clients.eobi_bearer is
  'DECIDED 2026-10-22 (0551). EOBI for this client''s guards: ''employee'' — the employee share of the rate in force is '
  'deducted from each guard and the company pays the employer share; ''company'' — nothing is deducted and the company '
  'pays both; null — no EOBI. The amounts are the dated rate in statutory_rates, never per client.';
comment on column public.clients.eobi_enabled is 'SUPERSEDED 2026-10-22 (0551) by eobi_bearer. Payroll no longer reads it.';
comment on column public.clients.eobi_amount is 'SUPERSEDED 2026-10-22 (0551) by the dated rate in statutory_rates. Payroll no longer reads it.';
comment on column public.contracts.eobi_deduction is 'SUPERSEDED 2026-10-22 (0551) by clients.eobi_bearer. Payroll no longer reads it.';
comment on column public.contracts.eobi_amount is 'SUPERSEDED 2026-10-22 (0551) by the dated rate in statutory_rates. Payroll no longer reads it.';

-- ── the employer accrual, from the rate ──────────────────────────────────────
do $restate$
declare v_src text := (select prosrc from pg_proc where oid = 'public.fill_eobi_employer'::regproc);
begin
  if position('0551' in v_src) > 0 then return; end if;  -- replay
  if md5(v_src) <> 'da630abe8bb8df8804f7710583afd6f9' then
    raise exception '0551 REFUSED: fill_eobi_employer is not the body 0524 wrote (md5 %). Someone else edited it; restating would discard that.', md5(v_src);
  end if;
  execute $fn$
create or replace function public.fill_eobi_employer()
returns trigger
language plpgsql security definer set search_path to 'public'
as $body$
declare v_bearer text; v_emp numeric; v_er numeric;
begin
  -- Only when what decides it changes, so an unrelated edit to a disbursed or
  -- locked payslip is not turned into an employer-EOBI edit.
  if tg_op = 'UPDATE'
     and old.eobi is not distinct from new.eobi
     and old.company_id is not distinct from new.company_id
     and old.employee_id is not distinct from new.employee_id
     and old.period_month is not distinct from new.period_month then
    return new;
  end if;
  -- 0551: the employer share is the dated rate for the payslip's month. Where
  -- the guard's share was deducted the company pays the employer share; where
  -- the client is marked 'company' nothing is deducted and the company pays both.
  select c.eobi_bearer into v_bearer
    from public.employees e left join public.clients c on c.id = e.client_id
   where e.id = new.employee_id;
  if coalesce(new.eobi, 0) <= 0 and v_bearer is distinct from 'company' then
    new.eobi_employer := 0;
    return new;
  end if;
  select r.employee_amount, r.employer_amount into v_emp, v_er
    from public.statutory_rate_on(new.company_id, 'eobi', new.period_month) r;
  if v_er is null then
    -- DECIDED 2026-10-17: refuse, never accrue zero silently.
    raise exception 'No EOBI rate is in force for %, so this payslip cannot be saved: payroll would accrue no employer EOBI and the client''s cost would be understated. Set the EOBI rate from that month first. Nothing has been recorded.',
      to_char(new.period_month, 'FMMonth YYYY') using errcode = 'P0001';
  end if;
  new.eobi_employer := case when coalesce(new.eobi, 0) > 0 then v_er else v_emp + v_er end;
  return new;
end;
$body$
  $fn$;
end $restate$;

alter table public.payroll_statutory_settings drop column if exists eobi_employer_amount;

-- ── asserts ───────────────────────────────────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_hmc_emp uuid; v_miu_emp uuid; v_miu uuid; v_er numeric; v_emp numeric;
begin
  select r.employee_amount, r.employer_amount into v_emp, v_er from public.statutory_rate_on(v_co, 'eobi', '2026-10-01') r;
  if v_emp is distinct from 407 or v_er is distinct from 2035 then
    raise exception '0551 REFUSED: EOBI for October is % + %, expected 407 + 2,035.', v_emp, v_er;
  end if;
  if exists (select 1 from public.statutory_rate_on(v_co, 'eobi', '2026-09-01')) then
    raise exception '0551 REFUSED: a rate is in force before October — September''s payslips would be re-priced.';
  end if;
  if (select count(*) from public.clients where company_id = v_co and eobi_bearer = 'employee') <> 3 then
    raise exception '0551 REFUSED: % clients bear EOBI by deduction, expected HMC, Emaar and Wusat.',
      (select count(*) from public.clients where company_id = v_co and eobi_bearer = 'employee');
  end if;
  if exists (select 1 from public.tenant_guard_gaps() where function_name in ('statutory_rate_on', 'change_statutory_rate')) then
    raise exception '0551 REFUSED: tenant_guard_gaps names a rate function.';
  end if;
  if exists (select 1 from public.payslips where company_id = v_co and period_month >= '2026-10-01') then
    raise notice '0551: October payslips exist — proof skipped on replay.';
    return;
  end if;

  select e.id into v_hmc_emp from public.employees e join public.clients c on c.id = e.client_id
   where c.company_id = v_co and c.name = 'HMC Taxila' order by e.id limit 1;
  select c.id, e.id into v_miu, v_miu_emp from public.employees e join public.clients c on c.id = e.client_id
   where c.company_id = v_co and c.name = 'MIU' order by e.id limit 1;
  begin
    insert into public.payslips (company_id, employee_id, period_month, eobi) values (v_co, v_hmc_emp, '2026-10-01', 407);
    select eobi_employer into v_er from public.payslips where employee_id = v_hmc_emp and period_month = '2026-10-01';
    if v_er <> 2035 then raise exception '0551 REFUSED: an HMC payslip withholding 407 accrued %, expected 2,035.', v_er; end if;

    update public.clients set eobi_bearer = 'company' where id = v_miu;
    insert into public.payslips (company_id, employee_id, period_month, eobi) values (v_co, v_miu_emp, '2026-10-01', 0);
    select eobi_employer into v_er from public.payslips where employee_id = v_miu_emp and period_month = '2026-10-01';
    if v_er <> 2442 then raise exception '0551 REFUSED: a payslip where the company absorbs EOBI accrued %, expected 2,442.', v_er; end if;

    begin
      perform public.change_statutory_rate(v_co, 'eobi', 420, 2100, '2026-10-01', 'proof — under payslips');
      raise exception '0551 REFUSED: a change under existing payslips was accepted.';
    exception when others then
      if sqlerrm not like 'Payslips for October 2026 already carry EOBI at the old rate.%' then raise; end if;
    end;
    raise exception '0551-SENTINEL';
  exception when others then
    if sqlerrm <> '0551-SENTINEL' then raise; end if;
  end;
  if exists (select 1 from public.payslips where company_id = v_co and period_month = '2026-10-01')
     or (select eobi_bearer from public.clients where id = v_miu) is not null then
    raise exception '0551 REFUSED: the proof survived its rollback.';
  end if;
  raise notice '0551: EOBI 407 + 2,035 from October 2026; HMC, Emaar and Wusat deduct; employer accrual from the rate.';
end $mig$;
