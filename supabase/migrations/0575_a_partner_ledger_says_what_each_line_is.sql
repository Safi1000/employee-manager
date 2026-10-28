-- 0575 — a partner's ledger says what each line is
--
-- Shayan, 28 Oct 2026: "the remaining profit of lahore is not being reflected
-- in ledgers of shujaat mehmood and shafqat … also write properly in ledger
-- details of transaction, for eg profit share from 1st sept to 30th isb/rwp
-- region xyz".
--
-- What the ledger said, and what it says now (partner_ledger; several authors,
-- so surgery, each anchor asserted to appear exactly once):
--
--   * A posted share read "SEPTEMBER 2026" — twice, for Shujaat, with nothing
--     to say one was ISB/RWP and the other Kashmir. Each run line already
--     carries its region (journal_lines.branch_id) and the run its shares, so
--     it now reads "PROFIT SHARE — ISB/RWP · 1–30 Sep 2026 (equity 100%)".
--   * Shafqat's 45% of Lahore is an expense from his cash holding (0573:
--     Lahore is outside the partnership; his share is a cost to GGS). In his
--     ledger it read "EXPENSE — 0573: 45% profit share …", as if it were cash
--     he spent for the company. It is his remuneration. expenses gains
--     share_partner_id — set on the six rows that ARE his share — and the
--     ledger shows those as PROFIT SHARE in the remuneration column. The
--     balance is the same either way (an expense from his custody and a share
--     both raise what GGS owes him); only what the line says, and which column
--     it is in, changes.
--   * Every other custody expense now names its category and client
--     ("EXPENSE — Payroll/Salary Expense · Berger Paints — Salaries, September"),
--     without the migration-number prefix.
--   * Cash a bank handed to a partner read "Cash withdrawn to custodian"; it
--     now says from which bank ("FROM Askari Bank — …").
--
-- NOT changed: when a share is posted. Lahore's October profit (613,356 to
-- Shujaat, 0573) is in the October run, which is not posted yet; it appears in
-- his ledger the moment that run is posted, as every month's share does.
--
-- Asserted: the six share rows are Shafqat's 45% and total 501,836
-- (58,699 + 94,393 + 348,744); his ledger's closing balance is unchanged and
-- now carries those six as PROFIT SHARE lines; Shujaat's September lines name
-- ISB/RWP and Kashmir Branch and still add to 2,099,749.19.

alter table public.expenses add column if not exists share_partner_id uuid references public.partners(id);
comment on column public.expenses.share_partner_id is
  '0575: set when this expense IS a partner''s profit share (a region outside the partnership pays its partner''s share as a cost, from his own holding). The partner''s ledger shows it as PROFIT SHARE, not as an expense he paid.';

do $mig$
declare
  v_co      constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_shafqat constant uuid := (select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shafqat Ali Raza');
  v_shujaat constant uuid := (select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shujaat Mehmood');
  v_loc     constant uuid := '36c4c1ee-9630-4919-8e8d-f425953ff984';   -- Shafqat Ali Raza's cash
  v_def text; v_n int; v_total numeric; v_bal0 numeric; v_bal1 numeric; v_shares int; v_sep numeric; v_named int;
  a1 constant text := $a$           upper(to_char(r.period_month, 'FMMonth YYYY'))
             || case when je.is_reversal then ' — REVERSED' else '' end as x_part,$a$;
  r1 constant text := $r$           -- 0575: what the share is — region, period, and the partner's share of it
           'PROFIT SHARE — ' || coalesce((select b.name from public.branches b where b.id = jl.branch_id), 'all regions')
             || ' · ' || to_char(r.period_month, 'FMDD') || '–' || to_char((r.period_month + interval '1 month - 1 day')::date, 'FMDD Mon YYYY')
             || coalesce(' (' || (select case when o->>'row_kind' = 'REGIONAL_PARTNER' then 'regional ' else 'equity ' end
                                         || trim(to_char((o->>'share_pct')::numeric, 'FM990.##')) || '%'
                                    from jsonb_array_elements(coalesce(r.outputs, '[]'::jsonb)) o
                                   where o->>'partner_id' = p_partner_id::text and o->>'branch_id' = jl.branch_id::text
                                     and o->>'row_kind' in ('EQUITY_REGION', 'REGIONAL_PARTNER') limit 1) || ')', '')
             || case when je.is_reversal then ' — REVERSED' else '' end as x_part,$r$;
  a2 constant text := $a$    select e.expense_date::date, 'EXPENSE — ' || coalesce(nullif(e.description,''), 'expense'),
           -e.amount, 0::numeric, 'CUSTODY:EXPENSE'::text, null::uuid
      from public.expenses e join ploc on ploc.id = e.custodian_location_id
     where e.expense_date between v_from and v_to$a$;
  r2 constant text := $r$    -- 0575: a partner's own profit share (share_partner_id) is remuneration, not an
    -- expense he paid; every other expense names its category and client.
    select e.expense_date::date,
           case when e.share_partner_id = p_partner_id
                then 'PROFIT SHARE — ' || coalesce(b.name || ' · ', '') || coalesce(c.name || ' — ', '')
                     || regexp_replace(coalesce(e.description, ''), '^[0-9]{4}: ', '')
                else 'EXPENSE — ' || coalesce(ec.name || ' · ', '') || coalesce(c.name || ' — ', '')
                     || coalesce(nullif(regexp_replace(coalesce(e.description, ''), '^[0-9]{4}: ', ''), ''), 'expense') end,
           case when e.share_partner_id = p_partner_id then 0::numeric else -e.amount end,
           case when e.share_partner_id = p_partner_id then e.amount else 0::numeric end,
           case when e.share_partner_id = p_partner_id then 'SHARE:DECLARED_REGION' else 'CUSTODY:EXPENSE' end::text, null::uuid
      from public.expenses e join ploc on ploc.id = e.custodian_location_id
      left join public.clients c on c.id = e.client_id
      left join public.branches b on b.id = e.branch_id
      left join public.expense_categories ec on ec.id = e.category_id
     where e.expense_date between v_from and v_to$r$;
  a3 constant text := $a$    select bt.created_at::date, coalesce(nullif(bt.description,''), 'Bank / cash movement'),$a$;
  r3 constant text := $r$    select bt.created_at::date,
           case when bt.kind = 'withdraw_to_cash'   -- 0575: from which bank
                then 'FROM ' || coalesce((select ba.bank_name from public.bank_accounts ba where ba.id = bt.bank_account_id), 'bank')
                     || ' — ' || coalesce(nullif(nullif(bt.description, ''), 'Cash withdrawn to custodian'), 'cash handed to him')
                else coalesce(nullif(bt.description,''), 'Bank / cash movement') end,$r$;
begin
  if v_shafqat is null or v_shujaat is null then raise exception '0575 REFUSED: Shafqat or Shujaat not found among the partners.'; end if;

  -- ── Shafqat's share rows ──────────────────────────────────────────────────
  if not exists (select 1 from public.expenses where share_partner_id = v_shafqat) then
    update public.expenses set share_partner_id = v_shafqat
     where company_id = v_co and custodian_location_id = v_loc
       and description like '0573: 45% profit share, Maj Shafqat%';
    get diagnostics v_n = row_count;
    select coalesce(sum(amount), 0) into v_total from public.expenses where share_partner_id = v_shafqat;
    if v_n <> 6 or v_total <> 501836 then
      raise exception '0575 REFUSED: % share rows totalling %, expected 6 totalling 501,836.', v_n, v_total;
    end if;
  end if;

  -- ── the ledger ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan, to read the ledger
  v_def := pg_get_functiondef('public.partner_ledger(uuid, date, date)'::regprocedure);
  if position('0575' in v_def) > 0 then return; end if;  -- replay
  select sum(remuneration - cash_paid) into v_bal0 from public.partner_ledger(v_shafqat, '2026-09-01', '2026-10-31');

  v_n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if v_n <> 1 then raise exception '0575 REFUSED: the share-label anchor appears % times.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if v_n <> 1 then raise exception '0575 REFUSED: the custody-expense anchor appears % times.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a3, ''))) / length(a3);
  if v_n <> 1 then raise exception '0575 REFUSED: the custody-bank anchor appears % times.', v_n; end if;
  execute replace(replace(replace(v_def, a1, r1), a2, r2), a3, r3);

  -- ── what can break ────────────────────────────────────────────────────────
  select sum(remuneration - cash_paid) into v_bal1 from public.partner_ledger(v_shafqat, '2026-09-01', '2026-10-31');
  if v_bal1 is distinct from v_bal0 then
    raise exception '0575 REFUSED: Shafqat''s closing balance moved % → %.', v_bal0, v_bal1;
  end if;
  select count(*) into v_shares from public.partner_ledger(v_shafqat, '2026-09-01', '2026-10-31')
   where source = 'SHARE:DECLARED_REGION' and particulars like 'PROFIT SHARE — Lahore%';
  if v_shares <> 6 then raise exception '0575 REFUSED: Shafqat''s ledger shows % profit-share lines, not 6.', v_shares; end if;
  select coalesce(sum(remuneration), 0), count(*) filter (where particulars like 'PROFIT SHARE — ISB/RWP · 1–30 Sep 2026%' or particulars like 'PROFIT SHARE — Kashmir Branch · 1–30 Sep 2026%')
    into v_sep, v_named
    from public.partner_ledger(v_shujaat, '2026-09-01', '2026-09-30') where source = 'ALLOCATION';
  if v_sep <> 2099749.19 or v_named <> 2 then
    raise exception '0575 REFUSED: Shujaat''s September shares are % across % named lines, not 2,099,749.19 across 2.', v_sep, v_named;
  end if;
end $mig$;
