-- 0576 — Lahore is cleared client by client, and each clearance is posted to the partners
--
-- DECIDED 2026-10-28 (Shayan), the Lahore mechanism — NOT the other regions':
--   "develop a different mechanism for Lahore region … client wise … as long
--    as the client is losing money, Shafqat will cover it. As soon as we get
--    the money from the client, whatever date that may be, and that exact
--    client becomes profitable till that date, say 30th September, we'll get
--    our share … he'll get [all the expenses he did] back plus his profit
--    share … it will be client wise, not as a whole group … Islamabad, Pindi
--    or Kashmir … as it was before."
--
--   So a Lahore client is CLEARED through a date: its receipts in, Shafqat's
--   expenses for it and his 45% paid to him (expenses from his holding,
--   0573/0575), and GGS's 55% posted to the equity partners. A clearance is a
--   region_declared_profit row for that client and month, posted on its own
--   journal dated the cleared-through day — whenever the client clears, run or
--   no run. ISB/RWP and Kashmir stay on the monthly partnership run.
--   Whether a client has cleared (paid, and profitable to the date) is entered
--   when it happens, from Shafqat's statement; Bastion does not guess it.
--
-- DECIDED 2026-10-28 (Shayan):
--   * "we are going to close lahore region client wise till 30th september do
--     that regardless of payment received in october" — Lahore's declared
--     profit (0573: Berger 187,113; Popular Brands 69,554; Popular Water Tank
--     68,837; Waheed Shahzad 145,929; AlRabi 141,923 — 613,356, PRA 32,601)
--     moves from October to SEPTEMBER. October holds nothing for Lahore.
--   * "all of the expenses were before 30th september of lahore only payment
--     received and sent to him was this month" — the 47 expenses 0573 entered
--     from Shafqat's sheets move to 30 Sep (dates only; amounts unchanged).
--     The receipts (6, 21 Oct) and the transfers to him (9, 28 Oct) stay.
--   * "if we are adding profit to shafqats ledger the remaining needs to be
--     added to shujaats ledger as well" — and, asked, "Lahore only, keep
--     ISB/RWP as posted": September's run (posted 26 Oct) is NOT reversed and
--     re-run, because a re-run recomputes ISB/RWP at today's figures (−80,679
--     Shujaat, −33,821 Nauman). Lahore is posted to the equity partners ON
--     ITS OWN, beside the run.
--
-- The mechanism, new here:
--   * region_declared_profit.posted_journal_id — a client clearance posted to
--     the partners. post_declared_region_profit(branch, month) posts each
--     unposted row of the month, dated its last day: Dr 3100 Retained Earnings
--     / Cr each equity partner's capital by his share, one journal per client.
--     Refused only if that month's run is posted AND already carries the
--     region (it would count twice). unpost_declared_region_profit reverses one.
--   * partnership_allocation (several authors; surgery, anchor once) leaves a
--     posted row out of the declared sum, so a later re-run of September
--     cannot count Lahore a second time.
--   * declare_region_profit (0537, 0573; surgery) refuses to change a posted row.
--   * partner_ledger (several authors; surgery) shows a posted declared row as
--     "PROFIT SHARE — Lahore · Berger Paints … · client cleared through
--     30 Sep 2026 (equity 100%) — …", in the remuneration column, and keeps it out of the
--     catch-all GL lines.
--
-- Asserted: September's posted run is untouched; Shujaat's September ledger
-- carries the run's 2,099,749.19 and, beside it, five declared Lahore lines
-- totalling 613,356; nothing for Lahore remains declared in October; the 47
-- expenses are dated 30 Sep and still total 2,825,426; Shafqat's holding and
-- ledger still close at 0; no tenant or branch guard gaps.

alter table public.region_declared_profit
  add column if not exists posted_journal_id uuid references public.journal_entries(id);
comment on column public.region_declared_profit.posted_journal_id is
  '0576: the journal that posted this client clearance to the equity partners, outside any run. A posted row is left out of partnership_allocation, so a run cannot count it twice.';

-- ── the run leaves a posted declared row out ────────────────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.partnership_allocation(date, date, text, uuid)'::regprocedure);
  v_anchor constant text := $a$where d.branch_id = r.branch_id and d.period_month between p_start and p_end$a$;
  v_n int;
begin
  if position('0576' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0576 REFUSED: the declared-sum anchor appears % times in partnership_allocation.', v_n; end if;
  execute replace(v_def, v_anchor,
    v_anchor || $r$ and d.posted_journal_id is null /* 0576: posted outside the run already */$r$);
end $surgery$;

-- ── a posted declared row is not changed by declaring again ─────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.declare_region_profit(uuid, date, numeric, text, uuid, numeric)'::regprocedure);
  v_anchor constant text := E'  insert into public.region_declared_profit (company_id, branch_id, period_month, amount, note, client_id, pra_held)\n';
  v_n int;
begin
  if position('0576' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0576 REFUSED: the insert anchor appears % times in declare_region_profit.', v_n; end if;
  execute replace(v_def, v_anchor,
E'  -- 0576: a row already posted to the partners is changed only by unposting it first.\n' ||
E'  if exists (select 1 from public.region_declared_profit d\n' ||
E'              where d.branch_id = p_branch_id and d.period_month = v_m and d.posted_journal_id is not null\n' ||
E'                and coalesce(d.client_id, ''00000000-0000-0000-0000-000000000000''::uuid) = coalesce(p_client_id, ''00000000-0000-0000-0000-000000000000''::uuid)) then\n' ||
E'    raise exception ''This declared profit is already posted to the partners. Unpost it first. Nothing has been recorded.'';\n' ||
E'  end if;\n' || v_anchor);
end $surgery$;

-- ── posting a declared month to the partners, outside the run ───────────────
create or replace function public.post_declared_region_profit(p_branch_id uuid, p_month date)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid; v_m date := date_trunc('month', p_month)::date; v_end date;
  v_run public.profit_allocation_runs; v_re uuid; v_pct numeric; v_n int := 0;
  d record; v_lines jsonb; v_take numeric; v_je uuid; v_desc text;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_branch_id via public.branches
  if p_branch_id is not null then perform public.assert_same_company((select company_id from public.branches where id = p_branch_id)); end if;
  select company_id into v_company from public.branches where id = p_branch_id;
  if v_company is null then raise exception 'Choose the region. Nothing has been posted.'; end if;
  perform public.assert_branch_writable(p_branch_id);
  v_end := (v_m + interval '1 month - 1 day')::date;

  -- A clearance posts whenever the client clears, run or no run; a later run
  -- leaves a posted row out (partnership_allocation, above). Refused only when
  -- the month's run is posted and already carries this region.
  select * into v_run from public.profit_allocation_runs r
   where r.company_id = v_company and r.period_month = v_m and r.status = 'POSTED';
  if v_run.id is not null and exists (select 1 from jsonb_array_elements(coalesce(v_run.outputs, '[]'::jsonb)) o
              where o->>'row_kind' = 'EQUITY_REGION' and o->>'branch_id' = p_branch_id::text and abs((o->>'amount')::numeric) > 0.005) then
    raise exception 'The posted run for % already carries this region''s profit. Nothing has been posted.', to_char(v_m, 'Mon YYYY');
  end if;
  select coalesce(sum(p.profit_share_percent), 0) into v_pct from public.partners p
   where p.company_id = v_company and p.scope = 'COMPANY' and p.is_active and coalesce(p.profit_share_percent, 0) > 0;
  if v_pct <= 0 or v_pct > 100 then
    raise exception 'The equity partners'' shares add to % per cent, so nothing can be divided. Nothing has been posted.', v_pct;
  end if;
  v_re := public.coa_id(v_company, 'retained_earnings');

  for d in
    select x.*, b.name as region, c.name as client
      from public.region_declared_profit x
      join public.branches b on b.id = x.branch_id
      left join public.clients c on c.id = x.client_id
     where x.branch_id = p_branch_id and x.period_month = v_m and x.posted_journal_id is null and x.amount <> 0
     order by x.amount desc
  loop
    v_lines := '[]'::jsonb; v_take := 0;
    select coalesce(jsonb_agg(jsonb_build_object('account_id', p.coa_account_id, 'debit', 0,
                                                 'credit', round(d.amount * p.profit_share_percent / 100, 2), 'partner_id', p.id)), '[]'::jsonb),
           coalesce(sum(round(d.amount * p.profit_share_percent / 100, 2)), 0)
      into v_lines, v_take
      from public.partners p
     where p.company_id = v_company and p.scope = 'COMPANY' and p.is_active and coalesce(p.profit_share_percent, 0) > 0;
    v_desc := 'Client cleared, ' || d.region || coalesce(' — ' || d.client, '') || ' · through ' || to_char(v_end, 'FMDD Mon YYYY');
    v_je := public.post_journal(v_company, v_end, v_desc, 'region_declared_profit', d.id, false,
      jsonb_build_array(jsonb_build_object('account_id', v_re, 'debit', v_take, 'credit', 0)) || v_lines,
      p_branch_id);
    update public.region_declared_profit set posted_journal_id = v_je, updated_by = auth.uid(), updated_at = now() where id = d.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
comment on function public.post_declared_region_profit(uuid, date) is
  '0576: post a Lahore client clearance (a declared row) to the equity partners, one journal per client dated the cleared-through day (Dr 3100 / Cr each equity partner''s capital by his share) — whenever the client clears; refused only if that month''s posted run already carries the region.';
revoke all on function public.post_declared_region_profit(uuid, date) from public, anon;
grant execute on function public.post_declared_region_profit(uuid, date) to authenticated;

create or replace function public.unpost_declared_region_profit(p_declared_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d public.region_declared_profit;
begin
  perform public.require_perm('accounting.edit');
  -- tenant guard [resolved]: owning company from p_declared_id via public.region_declared_profit
  if p_declared_id is not null then perform public.assert_same_company((select company_id from public.region_declared_profit where id = p_declared_id)); end if;
  select * into d from public.region_declared_profit where id = p_declared_id for update;
  if d.id is null or d.posted_journal_id is null then raise exception 'That declared profit is not posted. Nothing has been changed.'; end if;
  perform public.assert_branch_writable(d.branch_id);
  perform public.reverse_journal_for_source(d.company_id, 'region_declared_profit', d.id, (d.period_month + interval '1 month - 1 day')::date);
  update public.region_declared_profit set posted_journal_id = null, updated_by = auth.uid(), updated_at = now() where id = d.id;
end $$;
revoke all on function public.unpost_declared_region_profit(uuid) from public, anon;
grant execute on function public.unpost_declared_region_profit(uuid) to authenticated;

-- ── the partner's ledger shows a posted declared row as his profit share ────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.partner_ledger(uuid, date, date)'::regprocedure);
  a1 constant text := E'       and coalesce(je.source_table, '''') <> ''profit_allocation''   -- 0445: read by remun, once\n';
  a2 constant text := E'  merged as (\n    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun\n';
  r2 constant text := $r$  -- 0576: a Lahore client cleared and posted to the partners — one line a client.
  declposted as (
    select je.entry_date as x_date,
           'PROFIT SHARE — ' || coalesce(b.name, 'region') || coalesce(' · ' || c.name, '')
             || ' · client cleared through ' || to_char((d.period_month + interval '1 month - 1 day')::date, 'FMDD Mon YYYY')
             || ' (equity ' || trim(to_char(pr.profit_share_percent, 'FM990.##')) || '%)'
             || coalesce(' — ' || nullif(d.note, ''), '')
             || case when je.is_reversal then ' — REVERSED' else '' end as x_part,
           0::numeric as x_cash,
           (coalesce(jl.credit, 0) - coalesce(jl.debit, 0)) as x_remun,
           'ALLOCATION:DECLARED'::text as x_src, null::uuid as x_eid
      from public.journal_lines jl
      join public.journal_entries je on je.id = jl.journal_entry_id
      join public.region_declared_profit d on d.id = je.source_id
      join public.partners pr on pr.id = p_partner_id
      left join public.branches b on b.id = d.branch_id
      left join public.clients c on c.id = d.client_id
     where v_coa is not null and jl.account_id = v_coa
       and je.source_table = 'region_declared_profit'
       and je.entry_date between v_from and v_to
  ),
  merged as (
    select x_date, x_part, x_cash, x_remun, x_src, x_eid from remun
    union all select x_date, x_part, x_cash, x_remun, x_src, x_eid from declposted
$r$;
  v_n int;
begin
  if position('0576' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if v_n <> 1 then raise exception '0576 REFUSED: the other-lines anchor appears % times in partner_ledger.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if v_n <> 1 then raise exception '0576 REFUSED: the merged anchor appears % times in partner_ledger.', v_n; end if;
  execute replace(replace(v_def, a1,
    a1 || E'       and coalesce(je.source_table, '''') <> ''region_declared_profit''   -- 0576: read by declposted\n'), a2, r2);
end $surgery$;

-- ── Lahore: to September, and posted ────────────────────────────────────────
do $mig$
declare
  v_co      constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_br      constant uuid := 'a46fd702-8796-4858-b338-142628ce33cf';   -- Lahore
  v_loc     constant uuid := '36c4c1ee-9630-4919-8e8d-f425953ff984';   -- Shafqat Ali Raza's cash
  v_run     constant uuid := '711c2044-7970-4172-95d7-4cc68c4067cd';   -- September's posted run
  v_shujaat constant uuid := (select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shujaat Mehmood');
  v_shafqat constant uuid := (select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shafqat Ali Raza');
  v_runjson jsonb; v_n int; v_total numeric; v_hold numeric; v_alloc numeric; v_decl numeric; v_lines int; v_bal numeric;
begin
  if exists (select 1 from public.region_declared_profit where branch_id = v_br and posted_journal_id is not null) then
    return;  -- replay
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  select to_jsonb(r) - 'updated_at' into v_runjson from public.profit_allocation_runs r where r.id = v_run;

  -- the expenses: dates only
  update public.expenses set expense_date = '2026-09-30'
   where company_id = v_co and description like '0573:%' and expense_date <> '2026-09-30';
  select count(*), coalesce(sum(amount), 0) into v_n, v_total from public.expenses
   where company_id = v_co and description like '0573:%' and expense_date = '2026-09-30';
  if v_n <> 47 or v_total <> 2825426 then
    raise exception '0576 REFUSED: % expenses dated 30 Sep totalling %, expected 47 totalling 2,825,426.', v_n, v_total;
  end if;

  -- the declared profit: October's rows become September's
  delete from public.region_declared_profit where branch_id = v_br and period_month = '2026-09-01' and client_id is null and amount = 0;
  update public.region_declared_profit
     set period_month = '2026-09-01',
         note = case when client_id = '9c0991ac-544a-4a62-ab28-69521e8b6165'
                     then 'GGS 55% of Berger — August 71,743 + September 115,370'
                     else 'GGS 55% of Popular, June–September' end,
         updated_at = now()
   where branch_id = v_br and period_month = '2026-10-01';
  if exists (select 1 from public.region_declared_profit where branch_id = v_br and period_month = '2026-10-01') then
    raise exception '0576 REFUSED: Lahore still has a row declared for October.';
  end if;

  -- posted to the partners, beside the run
  v_n := public.post_declared_region_profit(v_br, '2026-09-01');
  if v_n <> 5 then raise exception '0576 REFUSED: % declared rows posted, expected 5.', v_n; end if;

  -- ── what can break ──────────────────────────────────────────────────────────
  if (select to_jsonb(r) - 'updated_at' from public.profit_allocation_runs r where r.id = v_run) is distinct from v_runjson then
    raise exception '0576 REFUSED: September''s posted run changed.';
  end if;
  select coalesce(sum(remuneration) filter (where source = 'ALLOCATION'), 0),
         coalesce(sum(remuneration) filter (where source = 'ALLOCATION:DECLARED'), 0),
         count(*) filter (where source = 'ALLOCATION:DECLARED' and particulars like 'PROFIT SHARE — Lahore · % · client cleared through 30 Sep 2026 (equity 100%)%')
    into v_alloc, v_decl, v_lines
    from public.partner_ledger(v_shujaat, '2026-09-01', '2026-09-30');
  if v_alloc <> 2099749.19 or v_decl <> 613356 or v_lines <> 5 then
    raise exception '0576 REFUSED: Shujaat''s September ledger: run % (expected 2,099,749.19), declared % across % lines (expected 613,356 across 5).', v_alloc, v_decl, v_lines;
  end if;
  if (select amount from public.partnership_allocation('2026-09-01', '2026-09-30', 'cash', v_co)
       where row_kind = 'EQUITY_REGION' and branch_id = v_br) <> 0 then
    raise exception '0576 REFUSED: September''s allocation would still count Lahore (it is posted outside the run).';
  end if;
  select operational into v_hold from public.custodian_held_operational(v_co) where cash_location_id = v_loc;
  select sum(remuneration - cash_paid) into v_bal from public.partner_ledger(v_shafqat, '2026-09-01', '2026-10-31');
  if v_hold <> 0 or v_bal <> 0 then
    raise exception '0576 REFUSED: Shafqat''s holding % / ledger % — expected 0 / 0.', v_hold, v_bal;
  end if;
  if exists (select 1 from public.tenant_guard_gaps()) then
    raise exception '0576 REFUSED: tenant_guard_gaps() reports a gap.';
  end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name in ('post_declared_region_profit', 'unpost_declared_region_profit')) then
    raise exception '0576 REFUSED: branch_guard_gaps() reports a new function.';
  end if;
end $mig$;
