-- 0548 — EOBI and salary tax up to September were settled by the expenses
-- already booked for them
--
-- DECIDED 2026-10-22 (Shayan): "current eobi and taxes to remain as is
-- opening balances etc of EOBI should be 0 will start from next month
-- recording each thing."
--
-- Before Bastion had a statutory screen (0520), the EOBI and FBR challans were
-- booked as plain expenses:
--   * EOBI 266,500 on 14 Sep ("Eobi 109 guards")        — August's EOBI
--   * EOBI 244,200 on  2 Oct ("Eobi paid for 100 guards") — September's EOBI
--   * FBR   41,923 on 15 Sep ("FBR Taxes")   — includes August's salary tax 3,080
--   * FBR   27,013 on 15 Oct ("FBR Tax paid") — includes September's salary tax 2,962
-- Payroll meanwhile credited what it withheld to EOBI Payable (2300: 73,290 +
-- 76,611 = 149,901) and Salary Tax Payable (2450: 3,080 + 2,962 = 6,042). The
-- money left once, but the withheld part was counted twice: as the payable
-- that never cleared, and again inside the expense. The Statutory tab
-- therefore shows August and September as still owed.
--
-- Those expenses stay exactly as they are. Each month is marked settled BY
-- the expense that paid it: a statutory_remittances row with paid_via
-- 'Expense' that names the expense and moves no money, and one journal —
-- Dr the payable, Cr the cost account the expense was charged to (5100 for
-- EOBI, 7000 for the FBR payments) — dated the expense. The payables close to
-- zero and the cost keeps only the company's own share. October onward is
-- paid through "Pay a statutory liability" like any other month.
--
-- statutory_booked_as_cost (0520) flags a statutory-category expense booked
-- while the payable held a balance. It reads the balance on the expense's
-- date, and September's payroll had already accrued by 14 Sep, so the two
-- September-dated expenses stay flagged even once settled. It also flags
-- "PRA Tax paid" (15,346), which sits in the Taxes category but is sales tax,
-- not salary tax. All of these are the payments Shayan decided stay as they
-- are, so the check is amended by surgery (one anchor, asserted once) to
-- skip an expense that settled a month here, and any statutory-category
-- expense on or before 15 Oct 2026 — the last challan paid as an expense.
-- From October's payroll on, the flag works as before.
--
-- Asserted: each month's due is the figure above before, and zero after; both
-- payables are zero; statutory_booked_as_cost names none of the five expenses.
-- Replayed on a database that already has the rows, it does nothing.

alter table public.statutory_remittances
  add column if not exists settled_by_expense_id uuid references public.expenses(id);

alter table public.statutory_remittances drop constraint if exists statutory_remittances_paid_via_check;
alter table public.statutory_remittances add constraint statutory_remittances_paid_via_check
  check (paid_via = any (array['Cash'::text, 'Bank'::text, 'Expense'::text]));
alter table public.statutory_remittances drop constraint if exists statutory_remittances_settled_by_expense_check;
alter table public.statutory_remittances add constraint statutory_remittances_settled_by_expense_check
  check ((paid_via = 'Expense') = (settled_by_expense_id is not null));

comment on column public.statutory_remittances.settled_by_expense_id is
  'DECIDED 2026-10-22 (0548). paid_via = ''Expense'': the month was paid by this expense, booked before the '
  'statutory screen existed. No money moves on this row; its journal moves the withheld part from the cost '
  'account the expense was charged to onto the payable. Used for EOBI and salary tax up to September 2026 only.';

-- statutory_booked_as_cost: surgery against the live definition.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.statutory_booked_as_cost(uuid)'::regprocedure);
  v_anchor constant text := E'     and bal.b > 0.005\n';
  v_marker constant text := '0548: settled by';
  v_n int;
begin
  if position(v_marker in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then
    raise exception '0548 REFUSED: the anchor appears % times in statutory_booked_as_cost, expected once.', v_n;
  end if;
  v_def := replace(v_def, v_anchor, v_anchor ||
    E'     -- 0548: settled by this expense, or paid as an expense before statutory\n' ||
    E'     -- recording began with October''s payroll (DECIDED 2026-10-22): left as they are.\n' ||
    E'     and not exists (select 1 from public.statutory_remittances sr where sr.settled_by_expense_id = x.id)\n' ||
    E'     and x.expense_date > date ''2026-10-15''\n');
  execute v_def;
end $surgery$;

do $mig$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  r record; v_due numeric; v_row public.statutory_remittances%rowtype; v_branch uuid; v_bal numeric;
begin
  for r in
    select * from (values
      ('eobi',       date '2026-08-01', uuid '71639b7a-530d-4d85-8be1-e705b7721054', 73290::numeric, 'cos_statutory', 'EOBI'),
      ('eobi',       date '2026-09-01', uuid '3da6f6fb-50fc-4a82-94ff-c74e810dbab9', 76611::numeric, 'cos_statutory', 'EOBI'),
      ('salary_tax', date '2026-08-01', uuid '69091ca9-a5a1-404e-9d71-cbf0f37a3393',  3080::numeric, 'income_tax',    'Salary tax (FBR)'),
      ('salary_tax', date '2026-09-01', uuid '6bb0cfb0-9f27-4219-ba7a-f6d27dcc4b61',  2962::numeric, 'income_tax',    'Salary tax (FBR)')
    ) t(scheme, m, expense_id, expected, cost_key, label)
  loop
    if exists (select 1 from public.statutory_remittances s where s.settled_by_expense_id = r.expense_id and s.scheme = r.scheme) then
      continue;  -- replay: already settled
    end if;
    select d.due into v_due from public.statutory_liability_due(v_co, r.scheme, r.m) d;
    if v_due is distinct from r.expected then
      raise exception '0548 REFUSED: % for % is due %, expected %. Something changed since this was written.',
        r.scheme, to_char(r.m, 'Mon YYYY'), v_due, r.expected;
    end if;
    select branch_id into v_branch from public.expenses where id = r.expense_id;
    v_branch := coalesce(v_branch, public.head_office_region(v_co));

    insert into public.statutory_remittances
      (company_id, branch_id, scheme, period_month, amount, liability_portion, cost_portion,
       paid_on, paid_via, settled_by_expense_id, notes)
    select v_co, v_branch, r.scheme, r.m, r.expected, r.expected, 0,
           x.expense_date, 'Expense', x.id,
           'Paid by the expense "' || x.description || '" (' || to_char(x.amount, 'FM999,999,990') || ') — 0548'
      from public.expenses x where x.id = r.expense_id
    returning * into v_row;

    perform public.post_journal(
      v_co, v_row.paid_on,
      r.label || ' for ' || to_char(r.m, 'FMMonth YYYY') || ' settled by an expense already booked',
      'statutory_remittances', v_row.id, false,
      jsonb_build_array(
        jsonb_build_object('key', public.statutory_liability_key(r.scheme), 'debit', r.expected, 'credit', 0),
        jsonb_build_object('key', r.cost_key, 'debit', 0, 'credit', r.expected)),
      v_branch);

    select d.due into v_due from public.statutory_liability_due(v_co, r.scheme, r.m) d;
    if v_due <> 0 then
      raise exception '0548 REFUSED: % for % still shows % due after settling.', r.scheme, to_char(r.m, 'Mon YYYY'), v_due;
    end if;
  end loop;

  -- Each payable now holds exactly what the Statutory tab says is owed — zero
  -- today, and October's withholding once October's payroll accrues (replay).
  for r in select unnest(array['eobi', 'salary_tax']) s loop
    select coalesce(sum(jl.credit - jl.debit), 0) into v_bal
      from public.journal_lines jl join public.chart_of_accounts a on a.id = jl.account_id
     where a.company_id = v_co and a.system_key = public.statutory_liability_key(r.s);
    select v_bal - coalesce(sum(d.due), 0) into v_bal
      from (select distinct period_month from public.payslips where company_id = v_co) m
      cross join lateral public.statutory_liability_due(v_co, r.s, m.period_month) d;
    if v_bal <> 0 then
      raise exception '0548 REFUSED: % payable differs from what is owed by % after settling.', r.s, v_bal;
    end if;
  end loop;

  if exists (select 1 from public.statutory_booked_as_cost(v_co) b
              where b.expense_id in ('71639b7a-530d-4d85-8be1-e705b7721054', '3da6f6fb-50fc-4a82-94ff-c74e810dbab9',
                                     '69091ca9-a5a1-404e-9d71-cbf0f37a3393', '6bb0cfb0-9f27-4219-ba7a-f6d27dcc4b61',
                                     '0b295ca5-4988-4ecf-9a2a-2318db9fa891')) then
    raise exception '0548 REFUSED: statutory_booked_as_cost still names one of the five expenses.';
  end if;
  raise notice '0548: EOBI and salary tax for August and September settled by their expenses; both payables zero.';
end $mig$;
