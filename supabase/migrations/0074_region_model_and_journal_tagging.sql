-- Region model & the inheritance rule (spec section 1).
--
-- Regions are first-class entities: Islamabad–Rawalpindi, Lahore, Peshawar
-- (extensible), plus Head Office as a special central region. Every core
-- object carries a home region.
--
-- Design note: `branches` IS the region table. It already carried
-- is_head_office and was already FK'd from employees / clients / expenses /
-- inventory_items / profiles, so promoting it in place avoids a parallel
-- concept that would have to be kept in sync forever. The table keeps its
-- name for now; `region_*` helpers below are the vocabulary the rest of the
-- system should use.
--
-- The inheritance rule: region is INHERITED from the object, never manually
-- picked — an expense inherits from its client/site, an invoice from its
-- client, a payroll line from its employee. Only genuinely shared costs post
-- to Head Office. Enforced by triggers below, not by UI convention, so every
-- write path (app, bulk import, direct SQL) obeys it.
--
-- Journal tagging: every journal line carries a region tag, threaded through
-- post_journal — the single posting chokepoint — so it cannot be bypassed.

-- ---------------------------------------------------------------------------
-- 1. Region entity
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.region_kind as enum ('regional', 'head_office');
exception when duplicate_object then null; end $$;

alter table public.branches
  add column if not exists code   text,
  add column if not exists active boolean not null default true;

-- `kind` is generated from is_head_office rather than stored independently:
-- one source of truth means the two can never drift apart.
alter table public.branches
  add column if not exists kind public.region_kind
    generated always as (
      case when is_head_office then 'head_office'::public.region_kind
           else 'regional'::public.region_kind end
    ) stored;

-- Region codes are the stable handle for a region (HO, ISB-RWP, LHR, PSH).
-- Seeded from the name; unique per company where present.
update public.branches
   set code = upper(regexp_replace(trim(name), '[^A-Za-z0-9]+', '-', 'g'))
 where code is null;

create unique index if not exists idx_branches_company_code
  on public.branches (company_id, code) where code is not null;

-- Exactly one Head Office per company. Already true for all 8 companies; this
-- keeps it true. Head Office is what shared costs fall back to, so a company
-- with zero or two of them would silently corrupt the inheritance rule.
create unique index if not exists idx_branches_one_head_office
  on public.branches (company_id) where is_head_office;

create index if not exists idx_branches_company_active
  on public.branches (company_id) where active;

-- ---------------------------------------------------------------------------
-- 2. Region resolvers — the inheritance rule, expressed once.
-- ---------------------------------------------------------------------------

-- The central region every company has. Shared costs land here (spec §6).
create or replace function public.head_office_region(p_company_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.branches
   where company_id = p_company_id and is_head_office
   limit 1;
$$;

create or replace function public.region_for_client(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.clients where id = p_client_id;
$$;

-- An employee's region is their own, falling back to the client (site) they
-- are deployed to. Migration 0057 already cascades client → employee, so
-- these agree in practice; the fallback covers employees not yet cascaded.
create or replace function public.region_for_employee(p_employee_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(e.branch_id, c.branch_id)
    from public.employees e
    left join public.clients c on c.id = e.client_id
   where e.id = p_employee_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. Region columns on the objects that lacked one
-- ---------------------------------------------------------------------------

alter table public.invoices
  add column if not exists branch_id uuid references public.branches(id);
alter table public.payslips
  add column if not exists branch_id uuid references public.branches(id);
alter table public.invoice_payments
  add column if not exists branch_id uuid references public.branches(id);

create index if not exists idx_invoices_branch          on public.invoices(branch_id);
create index if not exists idx_payslips_branch          on public.payslips(branch_id);
create index if not exists idx_invoice_payments_branch  on public.invoice_payments(branch_id);

-- ---------------------------------------------------------------------------
-- 4. Inheritance triggers
--
-- These deliberately OVERWRITE any region supplied by the caller when a
-- parent object exists — that is the point of the rule. Where no parent
-- exists the cost is genuinely shared and falls back to Head Office.
-- ---------------------------------------------------------------------------

-- Invoice → its client.
create or replace function public.inherit_region_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_invoices_region on public.invoices;
create trigger trg_bbb_invoices_region
  before insert or update of client_id, company_id on public.invoices
  for each row execute function public.inherit_region_invoice();

-- Invoice payment → the invoice it settles (therefore that invoice's client).
create or replace function public.inherit_region_invoice_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select i.branch_id into v_region from public.invoices i where i.id = new.invoice_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_invoice_payments_region on public.invoice_payments;
create trigger trg_bbb_invoice_payments_region
  before insert or update of invoice_id, client_id, company_id on public.invoice_payments
  for each row execute function public.inherit_region_invoice_payment();

-- Payroll line → its employee.
create or replace function public.inherit_region_payslip()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_payslips_region on public.payslips;
create trigger trg_bbb_payslips_region
  before insert or update of employee_id, company_id on public.payslips
  for each row execute function public.inherit_region_payslip();

-- Advance → its employee.
create or replace function public.inherit_region_advance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_employee(new.employee_id),
    public.region_for_client(new.client_id),
    new.branch_id,
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_advances_region on public.advances;
create trigger trg_bbb_advances_region
  before insert or update of employee_id, client_id, company_id on public.advances
  for each row execute function public.inherit_region_advance();

-- Expense → its client (site).
--
-- CAVEAT: `expenses` has no employee_id or asset_id, so of the three sources
-- the spec names (employee / site / asset) only the site is derivable today.
-- An expense WITH a client inherits strictly. An expense WITHOUT one keeps an
-- explicitly-set region if it has one — a regional office's rent is a real
-- regional cost, and forcing it to Head Office would misstate regional P&L
-- more than trusting the entry does. It falls back to Head Office only when
-- nothing at all identifies it, which matches "only genuinely shared costs
-- post to Head Office". Adding expenses.employee_id / asset_id later would
-- let this become strict inheritance in every case.
create or replace function public.inherit_region_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    new.branch_id,
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_expenses_region on public.expenses;
create trigger trg_bbb_expenses_region
  before insert or update of client_id, company_id on public.expenses
  for each row execute function public.inherit_region_expense();

-- ---------------------------------------------------------------------------
-- 5. Backfill regions on existing rows
-- ---------------------------------------------------------------------------

update public.invoices i
   set branch_id = coalesce(public.region_for_client(i.client_id),
                            public.head_office_region(i.company_id))
 where i.branch_id is null;

update public.payslips p
   set branch_id = coalesce(public.region_for_employee(p.employee_id),
                            public.head_office_region(p.company_id))
 where p.branch_id is null;

update public.invoice_payments ip
   set branch_id = coalesce((select i.branch_id from public.invoices i where i.id = ip.invoice_id),
                            public.region_for_client(ip.client_id),
                            public.head_office_region(ip.company_id))
 where ip.branch_id is null;

update public.advances a
   set branch_id = coalesce(public.region_for_employee(a.employee_id),
                            public.region_for_client(a.client_id),
                            public.head_office_region(a.company_id))
 where a.branch_id is null;

update public.expenses e
   set branch_id = coalesce(public.region_for_client(e.client_id),
                            public.head_office_region(e.company_id))
 where e.branch_id is null;

update public.employees em
   set branch_id = coalesce(public.region_for_client(em.client_id),
                            public.head_office_region(em.company_id))
 where em.branch_id is null;

-- ---------------------------------------------------------------------------
-- 6. Journal region tagging
--
-- "Every double-entry journal line carries a region tag. This must run
-- through the posting layer from the start." post_journal is the only way
-- lines are created, so threading the tag through it covers every posting —
-- current and future — by construction.
-- ---------------------------------------------------------------------------

alter table public.journal_lines
  add column if not exists branch_id uuid references public.branches(id);

create index if not exists idx_jl_branch on public.journal_lines(branch_id);

-- Dropped rather than replaced: adding a defaulted parameter to a live
-- function creates an overload, and the existing 7-arg callers would then be
-- ambiguous. plpgsql resolves callees at runtime, so callers survive the drop.
drop function if exists public.post_journal(uuid, date, text, text, uuid, boolean, jsonb);

create or replace function public.post_journal(
  p_company_id   uuid,
  p_date         date,
  p_description  text,
  p_source_table text,
  p_source_id    uuid,
  p_is_reversal  boolean,
  p_lines        jsonb,  -- [{ "key": "cash", "debit": 1000, "credit": 0, "region": "<uuid>" }]
  p_region_id    uuid default null
)
returns uuid language plpgsql security definer as $$
declare
  v_entry_id uuid;
  v_line     jsonb;
  v_acct_id  uuid;
  v_debit    numeric;
  v_credit   numeric;
  v_region   uuid;
  v_any      boolean := false;
  v_user     uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  -- Never leave a line untagged: an entry with no region resolves to the
  -- company's Head Office, which is where genuinely shared costs belong.
  p_region_id := coalesce(p_region_id, public.head_office_region(p_company_id));

  v_entry_id := gen_random_uuid();

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_debit  := coalesce((v_line->>'debit')::numeric, 0);
    v_credit := coalesce((v_line->>'credit')::numeric, 0);
    if v_debit = 0 and v_credit = 0 then continue; end if;

    v_acct_id := public.coa_id(p_company_id, v_line->>'key');
    if v_acct_id is null then continue; end if;

    -- Per-line override exists so a future apportionment run (spec §6) can
    -- split one entry across regions without a second posting path.
    v_region := coalesce(nullif(v_line->>'region', '')::uuid, p_region_id);

    if not v_any then
      insert into public.journal_entries
        (id, company_id, entry_date, description, source_table, source_id, is_reversal, posted_by)
      values
        (v_entry_id, p_company_id, p_date, p_description, p_source_table, p_source_id, p_is_reversal, v_user);
      v_any := true;
    end if;

    insert into public.journal_lines (journal_entry_id, account_id, debit, credit, branch_id)
    values (v_entry_id, v_acct_id, v_debit, v_credit, v_region);
  end loop;

  if v_any then return v_entry_id; end if;
  return null;
end;
$$;

-- A reversal must carry the same region as the line it reverses, or the two
-- would land in different regional P&Ls and neither would net to zero.
create or replace function public.reverse_journal_for_source(
  p_company_id   uuid,
  p_source_table text,
  p_source_id    uuid,
  p_date         date
)
returns void language plpgsql security definer as $$
declare
  v_entry record;
  v_rev_id uuid;
  v_user   uuid;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  for v_entry in
    select je.id, je.description
    from public.journal_entries je
    where je.company_id = p_company_id
      and je.source_table = p_source_table
      and je.source_id = p_source_id
      and je.is_reversal = false
      and not exists (
        select 1 from public.journal_entries rev
        where rev.company_id = p_company_id
          and rev.source_table = p_source_table
          and rev.source_id = p_source_id
          and rev.is_reversal = true
          and rev.description like '%(reversal of ' || je.id::text || ')%'
      )
  loop
    v_rev_id := gen_random_uuid();
    insert into public.journal_entries
      (id, company_id, entry_date, description, source_table, source_id, is_reversal, posted_by)
    values
      (v_rev_id, p_company_id, p_date,
       v_entry.description || ' (reversal of ' || v_entry.id || ')',
       p_source_table, p_source_id, true, v_user);

    insert into public.journal_lines (journal_entry_id, account_id, debit, credit, branch_id)
    select v_rev_id, jl.account_id, jl.credit, jl.debit, jl.branch_id  -- swap debit↔credit, keep region
    from public.journal_lines jl
    where jl.journal_entry_id = v_entry.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Re-point the source triggers to pass their region.
--    Bodies are unchanged from migration 0042 apart from the region argument.
-- ---------------------------------------------------------------------------

create or replace function public.journal_on_invoice()
returns trigger language plpgsql security definer as $$
declare
  v_amt     numeric;
  v_wht     numeric;
  v_net     numeric;
  v_rev_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoices', old.id, old.invoice_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.invoice_amount is distinct from new.invoice_amount
       or coalesce(old.withholding_tax, 0) is distinct from coalesce(new.withholding_tax, 0)
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoices', new.id, old.invoice_date);
    else
      return new;
    end if;
  end if;

  v_amt := new.invoice_amount;
  v_wht := coalesce(new.withholding_tax, 0);
  v_net := v_amt - v_wht;
  v_rev_key := 'revenue_security';
  begin
    select case when c.client_type = 'guard_deployment' then 'revenue_guard' else 'revenue_security' end
      into v_rev_key
    from public.clients c where c.id = new.client_id;
  exception when others then null;
  end;

  perform public.post_journal(
    new.company_id, new.invoice_date,
    'Invoice ' || coalesce(new.invoice_number, new.id::text),
    'invoices', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar',          'debit', v_net, 'credit', 0),
      jsonb_build_object('key', v_rev_key,     'debit', 0,     'credit', v_net),
      jsonb_build_object('key', 'wht_payable', 'debit', 0,     'credit', v_wht)
    ),
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_invoice_payment()
returns trigger language plpgsql security definer as $$
declare
  v_dest text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'invoice_payments', old.id, old.payment_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'invoice_payments', new.id, old.payment_date);
    else
      return new;
    end if;
  end if;

  v_dest := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  perform public.post_journal(
    new.company_id, new.payment_date,
    'Payment received',
    'invoice_payments', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_dest, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', 'ar',   'debit', 0,          'credit', new.amount)
    ),
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_expense()
returns trigger language plpgsql security definer as $$
declare
  v_exp_key  text;
  v_cr_key   text;
  v_cat_name text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'expenses', old.id, old.expense_date);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.payment_mode is distinct from new.payment_mode
       or old.category_id is distinct from new.category_id
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'expenses', new.id, old.expense_date);
    else
      return new;
    end if;
  end if;

  select name into v_cat_name from public.expense_categories where id = new.category_id;
  v_exp_key := public.map_expense_to_coa_key(coalesce(v_cat_name, ''), new.pl_category::text, new.client_id);

  v_cr_key := case
    when new.payment_mode = 'Cash' then 'cash'
    when new.payment_mode in ('Bank', 'Cheque') then 'bank'
    else 'ap'
  end;

  perform public.post_journal(
    new.company_id, new.expense_date,
    coalesce(v_cat_name, 'Expense') || coalesce(' — ' || new.description, ''),
    'expenses', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', v_exp_key, 'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', v_cr_key,  'debit', 0,          'credit', new.amount)
    ),
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_payslip()
returns trigger language plpgsql security definer as $$
declare
  v_payroll_key text;
  v_cr_key      text;
  v_emp_cat     text;
  v_lines       jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'payslips', old.id, old.period_month);
    return old;
  end if;

  if tg_op = 'INSERT' and not new.disbursed then return new; end if;
  if tg_op = 'UPDATE' then
    if old.disbursed = true and new.disbursed = true
       and old.final_salary is not distinct from new.final_salary
       and old.branch_id is not distinct from new.branch_id then
      return new;
    end if;
    if old.disbursed = true then
      perform public.reverse_journal_for_source(new.company_id, 'payslips', new.id, old.period_month);
    end if;
    if not new.disbursed then return new; end if;
  end if;

  select category into v_emp_cat from public.employees where id = new.employee_id;
  v_payroll_key := case when v_emp_cat = 'office_staff' then 'opex_office_payroll' else 'cos_payroll' end;
  v_cr_key := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  v_lines := jsonb_build_array(
    jsonb_build_object('key', v_payroll_key, 'debit', new.final_salary, 'credit', 0),
    jsonb_build_object('key', v_cr_key,      'debit', 0,                'credit', new.final_salary)
  );

  if coalesce(new.eobi, 0) > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('key', 'cos_statutory', 'debit', new.eobi, 'credit', 0),
      jsonb_build_object('key', 'eobi_payable',  'debit', 0,        'credit', new.eobi)
    );
  end if;

  perform public.post_journal(
    new.company_id, new.period_month,
    'Payroll — ' || left(new.period_month::text, 7),
    'payslips', new.id, false,
    v_lines,
    new.branch_id
  );
  return new;
end;
$$;

create or replace function public.journal_on_advance()
returns trigger language plpgsql security definer as $$
declare
  v_cr_key text;
begin
  if tg_op = 'DELETE' then
    perform public.reverse_journal_for_source(old.company_id, 'advances', old.id, old.advance_date);
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.amount is distinct from new.amount
       or old.branch_id is distinct from new.branch_id then
      perform public.reverse_journal_for_source(new.company_id, 'advances', new.id, old.advance_date);
    else
      return new;
    end if;
  end if;

  v_cr_key := case when new.payment_mode = 'Cash' then 'cash' else 'bank' end;

  perform public.post_journal(
    new.company_id, new.advance_date,
    'Employee advance',
    'advances', new.id, false,
    jsonb_build_array(
      jsonb_build_object('key', 'ar',     'debit', new.amount, 'credit', 0),
      jsonb_build_object('key', v_cr_key, 'debit', 0,          'credit', new.amount)
    ),
    new.branch_id
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Backfill the region tag on the 2.4k existing journal lines, from each
--    entry's source row. Manual entries have no source and fall back to Head
--    Office. Done last, so the source rows above are already regioned.
-- ---------------------------------------------------------------------------

update public.journal_lines jl
   set branch_id = src.branch_id
  from (
    select je.id as entry_id,
           coalesce(
             case je.source_table
               when 'invoices'         then (select i.branch_id  from public.invoices i         where i.id  = je.source_id)
               when 'invoice_payments' then (select ip.branch_id from public.invoice_payments ip where ip.id = je.source_id)
               when 'expenses'         then (select e.branch_id  from public.expenses e         where e.id  = je.source_id)
               when 'payslips'         then (select p.branch_id  from public.payslips p         where p.id  = je.source_id)
               when 'advances'         then (select a.branch_id  from public.advances a         where a.id  = je.source_id)
               else null
             end,
             public.head_office_region(je.company_id)
           ) as branch_id
      from public.journal_entries je
  ) src
 where jl.journal_entry_id = src.entry_id
   and jl.branch_id is null;

-- ---------------------------------------------------------------------------
-- 9. Region-aware regional P&L source. Every line is tagged, so a regional
--    P&L is now a plain group-by rather than a set of table-specific joins.
-- ---------------------------------------------------------------------------

-- security_invoker: the view must honour the caller's RLS on journal_entries,
-- not the owner's, or it would become a way around company scoping.
create or replace view public.journal_lines_regional
  with (security_invoker = true) as
  select jl.id,
         jl.journal_entry_id,
         jl.account_id,
         jl.debit,
         jl.credit,
         jl.branch_id,
         b.name  as region_name,
         b.code  as region_code,
         b.kind  as region_kind,
         je.company_id,
         je.entry_date,
         je.source_table,
         je.source_id,
         je.is_reversal
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
    left join public.branches b on b.id = jl.branch_id;
