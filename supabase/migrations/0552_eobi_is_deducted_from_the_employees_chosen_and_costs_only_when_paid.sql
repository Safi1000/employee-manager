-- 0552 — EOBI is deducted from the employees chosen, and costs only when paid
--
-- DECIDED 2026-10-22 (Shayan), replacing the client-level choice 0551 made
-- the same day:
--   "everyone who i select 407 will be deducted from oct payroll and become a
--   liability to company … then i would select say out of those 200 and office
--   staff … employees whose eobi i will pay rest will stay in liability
--   forever … the soft flags will be out of 200 whose eobi was deducted these
--   have age of 65 etc just to let us know nothing to be enforced. and the
--   cost say 90 hmc employees eobi was paid that much is netted off against
--   hmc. office staff if any cost lands in HO"
--   — and earlier: "not every employees EOBI is paid because sometimes client
--   refuses to pay soo i will select whose EOBI is to be paid".
--
-- So:
--   * employees.eobi_deduct: chosen per employee. Payroll withholds the
--     employee share of the dated rate (0551: 407) from exactly these, and the
--     payslip journal credits it to EOBI Payable (unchanged, post_payslip_accrual).
--     Seeded from who was deducted in September (190 people); Shayan adjusts.
--   * Payroll books NO employer EOBI any more. fill_eobi_employer (0551) and
--     its trigger are dropped: the employer share is a cost only for the
--     people actually paid on a challan, booked then on each one's client, or
--     on head office for office staff. DEFERRED: the challan itself — parked
--     at Shayan's word until October's (1–10 Nov 2026). Until it exists, what
--     payroll withholds simply sits in EOBI Payable.
--   * clients.eobi_bearer (0551) is dropped: who is deducted is now chosen by
--     employee, and the cost follows the payment, so a client-level switch
--     would be a second, disagreeing answer to the same question.
--   * Soft flags are read-only warnings on the screen; nothing here enforces them.
--
-- Asserted, rolled back by a sentinel: an October payslip withholding 407
-- accrues no employer EOBI, and EOBI owed for October is exactly the 407.

-- Seeded once, on first apply only: whoever was deducted in September.
do $seed$
declare v_n int;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employees' and column_name = 'eobi_deduct') then
    return;  -- replay: the choice is Shayan's now
  end if;
  alter table public.employees add column eobi_deduct boolean not null default false;
  update public.employees e set eobi_deduct = true
   where exists (select 1 from public.payslips p where p.employee_id = e.id and p.period_month = '2026-09-01' and coalesce(p.eobi, 0) > 0);
  get diagnostics v_n = row_count;
  if v_n <> (select count(distinct employee_id) from public.payslips where period_month = '2026-09-01' and coalesce(eobi, 0) > 0) then
    raise exception '0552 REFUSED: seeded % employees, not everyone deducted in September.', v_n;
  end if;
end $seed$;
comment on column public.employees.eobi_deduct is
  'DECIDED 2026-10-22 (0552). Payroll withholds the employee share of the dated EOBI rate from this employee and '
  'credits it to EOBI Payable. Chosen per employee by Shayan (not every client''s guards are paid for). Whether the '
  'company then pays the challan for him — and books the employer share on his client — is chosen at the challan.';

drop trigger if exists trg_ccc_payslips_fill_eobi_employer on public.payslips;
drop function if exists public.fill_eobi_employer();
comment on column public.payslips.eobi_employer is
  'Employer EOBI accrued at payroll — 0524 to 0551 only. From 0552 (DECIDED 2026-10-22) payroll accrues none: the '
  'employer share is booked when a challan is paid, for the people on it.';

alter table public.clients drop constraint if exists clients_eobi_bearer_check;
alter table public.clients drop column if exists eobi_bearer;

comment on table public.statutory_rates is
  'DECIDED 2026-10-22 (0551, 0552). Per head per month, by scheme: the employee share (withheld by payroll from the '
  'employees chosen) and the employer share (booked when a challan is paid, on each paid employee''s client). A change '
  'is a new row from its month, never an edit (EOBI went 370, 400, 407).';

-- ── asserts ───────────────────────────────────────────────────────────────────
do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_emp uuid; v_er numeric; v_acc numeric; v_n int;
begin
  select count(*) into v_n from public.employees where company_id = v_co and eobi_deduct;
  if exists (select 1 from pg_trigger where tgname = 'trg_ccc_payslips_fill_eobi_employer') then
    raise exception '0552 REFUSED: payroll still accrues employer EOBI.';
  end if;
  if exists (select 1 from public.payslips where company_id = v_co and period_month >= '2026-10-01') then
    raise notice '0552: October payslips exist — proof skipped on replay.';
    return;
  end if;

  select e.id into v_emp from public.employees e where e.company_id = v_co and e.eobi_deduct order by e.id limit 1;
  begin
    insert into public.payslips (company_id, employee_id, period_month, eobi) values (v_co, v_emp, '2026-10-01', 407);
    select eobi_employer into v_er from public.payslips where employee_id = v_emp and period_month = '2026-10-01';
    v_acc := public.statutory_accrued(v_co, 'eobi', '2026-10-01');
    if coalesce(v_er, 0) <> 0 or v_acc <> 407 then
      raise exception '0552 REFUSED: an October payslip withholding 407 accrued % employer and % owed, expected 0 and 407.', v_er, v_acc;
    end if;
    raise exception '0552-SENTINEL';
  exception when others then
    if sqlerrm <> '0552-SENTINEL' then raise; end if;
  end;
  if exists (select 1 from public.payslips where company_id = v_co and period_month = '2026-10-01') then
    raise exception '0552 REFUSED: the proof survived its rollback.';
  end if;
  raise notice '0552: EOBI withheld from the % employees chosen; no employer EOBI at payroll.', v_n;
end $mig$;
