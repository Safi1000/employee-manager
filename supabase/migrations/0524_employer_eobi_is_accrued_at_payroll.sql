-- 0524 — Employer EOBI is accrued at payroll, as a cost of that guard in that
-- month and in that month's client P&L.
--
-- NUMBER: written as 0524 on 2026-10-17. Claim it against
-- supabase_migrations.schema_migrations at apply time; rename the FILE if taken.
-- APPROVED 2026-10-17 to create the setting EMPTY; the amount follows separately.
--
-- DECIDED 2026-10-17 by the user: accrue employer EOBI at payroll. Recognising
-- it at payment understates every client's cost by its share of roughly
-- 193,000 a month and puts the charge in the wrong period. payslips.
-- eobi_employer already exists and post_payslip_accrual already posts it
-- (Dr 5100 split across the guard's clients by days, Cr 2300 EOBI Payable);
-- nothing has ever filled it — zero on all 661 payslips, and no code in src/ or
-- the database writes it.
--
-- WHERE THE AMOUNT LIVES: one company setting, payroll_statutory_settings.
-- eobi_employer_amount — a flat PKR per insured employee per month. The
-- employer contribution is set by statute and is the same for every insured
-- guard, unlike the employee's own deduction, which payroll already resolves
-- per contract or client (resolveEobiAmount). "Insured" is read the way payroll
-- already reads it: a payslip that withholds employee EOBI (eobi > 0) carries
-- the employer amount; one that withholds none carries none. A contract-level
-- override is NOT built: no case for one has been named, and an unused
-- override is a column nobody fills.
--
-- WHAT THIS DOES WHILE THE AMOUNT IS NULL: it REFUSES. DECIDED 2026-10-17 by
-- the user: "an unset rate that silently accrues nothing is worse than one
-- that stops payroll and says why." A payslip that withholds employee EOBI
-- cannot be created, or have its EOBI changed, until the employer amount is
-- set — the refusal names the setting. Payslips that withhold no EOBI, and
-- edits to existing payslips that do not touch EOBI (disbursing, notes,
-- payment mode), are not affected. No existing figure changes on apply.
-- CONSEQUENCE, stated so it is not discovered at the next run: the October
-- payroll cannot be generated for any guard who has EOBI withheld until the
-- amount is supplied. Supplying the amount is one statement plus a backfill,
-- both in the comment at the end.

create table if not exists public.payroll_statutory_settings (
  company_id           uuid primary key references public.companies(id),
  eobi_employer_amount numeric(10,2) check (eobi_employer_amount is null or eobi_employer_amount >= 0),
  decided              text,
  updated_at           timestamptz not null default now()
);
alter table public.payroll_statutory_settings enable row level security;
drop policy if exists company_members_read on public.payroll_statutory_settings;
create policy company_members_read on public.payroll_statutory_settings
  for select using (company_id = (select public.current_company_id()));
drop policy if exists ssa_read on public.payroll_statutory_settings;
create policy ssa_read on public.payroll_statutory_settings
  for select using ((select public.is_ssa_unscoped()));
comment on table public.payroll_statutory_settings is
  '0524. Company payroll statutory amounts. eobi_employer_amount: flat PKR per insured employee per month, filled onto every payslip that withholds employee EOBI. NULL = not yet supplied; a payslip withholding employee EOBI is then REFUSED, never accrued at zero (DECIDED 2026-10-17). Written by migration.';

insert into public.payroll_statutory_settings (company_id, eobi_employer_amount, decided)
select c.id, null, 'DECIDED 2026-10-17: accrue employer EOBI at payroll. Amount NOT YET SUPPLIED.'
  from public.companies c
on conflict (company_id) do nothing;

create or replace function public.fill_eobi_employer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_amt numeric;
begin
  -- Only when what decides it changes, so an unrelated edit to a disbursed or
  -- locked payslip is not turned into an employer-EOBI edit.
  if tg_op = 'UPDATE'
     and old.eobi is not distinct from new.eobi
     and old.company_id is not distinct from new.company_id then
    return new;
  end if;
  if coalesce(new.eobi, 0) <= 0 then
    new.eobi_employer := 0;   -- no employee EOBI withheld: no employer EOBI
    return new;
  end if;
  select s.eobi_employer_amount into v_amt
    from public.payroll_statutory_settings s where s.company_id = new.company_id;
  if v_amt is null then
    -- DECIDED 2026-10-17: refuse, never accrue zero silently.
    raise exception 'Employer EOBI is not set for this company, so this payslip (which withholds % of employee EOBI) cannot be saved: payroll would accrue no employer EOBI and every client''s cost would be understated. Set payroll_statutory_settings.eobi_employer_amount first. Nothing has been recorded.', new.eobi
      using errcode = 'P0001';
  end if;
  new.eobi_employer := v_amt;
  return new;
end;
$function$;

revoke execute on function public.fill_eobi_employer() from public, anon, authenticated;

-- BEFORE the journal trigger (trg_yyy_payslips_journal is AFTER), so the
-- accrual posts with the amount filled in.
drop trigger if exists trg_ccc_payslips_fill_eobi_employer on public.payslips;
create trigger trg_ccc_payslips_fill_eobi_employer
  before insert or update on public.payslips
  for each row execute function public.fill_eobi_employer();

do $$
begin
  if exists (select 1 from public.payroll_statutory_settings where eobi_employer_amount is not null) then
    raise exception '0524 FAILED: an employer EOBI amount is set; this migration is meant to land with none.';
  end if;
  if exists (select 1 from public.payslips where coalesce(eobi_employer, 0) <> 0) then
    raise exception '0524 FAILED: a payslip already carries employer EOBI; none was expected.';
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0524 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;

-- ===========================================================================
-- THE LAST STEP, once the user supplies the amount (its own authorisation):
--
--   update public.payroll_statutory_settings
--      set eobi_employer_amount = <AMOUNT>, decided = '<who, when, source>', updated_at = now()
--    where company_id = (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD');
--
-- and the backfill for months AFTER the cutover only (September 2026 onward):
-- touching eobi makes the trigger fill the amount and journal_on_payslip
-- re-post the accrual, client by client:
--
--   update public.payslips set eobi = eobi
--    where company_id = (select id from public.companies where name = 'GUARDS AND GUIDES (PVT) LTD')
--      and period_month >= date '2026-09-01' and eobi > 0;
--
-- August is NOT backfilled: it is before the cutover, and its employer EOBI
-- (193,210, inside the 14 Sep payment) adjusts the opening through the
-- remittance action instead. The backfill's dry run must show what the payroll
-- run lock does with disbursed September payslips before it is authorised.
-- ===========================================================================
