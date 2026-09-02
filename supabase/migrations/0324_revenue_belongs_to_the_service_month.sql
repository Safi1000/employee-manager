-- 0324 — a check that revenue is recognised in the month it was earned.
--
-- A4 says revenue belongs to the service month (period_start), not to
-- invoice_date. 0323 made an advance invoice defer its revenue and recognise it
-- when that month arrives. Nothing yet notices if it lands anywhere else.
--
-- WHY ar_control_equals_open_invoices CANNOT SEE THIS. That check compares the
-- AR control account against open invoices. Both sides of an invoice entry move
-- together at whatever single date the entry used, so posting the whole thing
-- into the wrong month leaves AR and invoices agreeing perfectly. It stays green
-- while the revenue sits in the wrong period — the same shape as the two errors
-- that cancelled (§9.15), and the reason this needs its own detector rather than
-- a tighter tolerance on an existing one.
--
-- HOW A RECOGNITION IS IDENTIFIED. Not "an entry that has a revenue line" —
-- editing an invoice reverses and reposts it, so the reversal also carries
-- revenue lines and would be counted as a second recognition. Instead the
-- detector nets credit minus debit per period: a reversal cancels the entry it
-- reverses, and only periods with a non-zero net remain. The pairs disappear
-- because they are equal and opposite, which is what they are.
--
-- A NULL period_start IS A FINDING, NOT A DEFAULT. If an invoice has revenue
-- posted and no period_start, the service month is unstated and the rule cannot
-- be checked. Falling back to invoice_date would be the fall-through defect
-- (§9.18): it would answer the question with a value nobody asserted, and the
-- check would pass by assuming what it was meant to verify. It is reported.
--
-- Measured before writing, on both databases: 9 recognitions, 0 in the wrong
-- period, 0 with an unstated service month. The check lands green and is
-- exercised — a check whose detector returns nothing on every input would be
-- green for the wrong reason.

create or replace function public.revenue_outside_service_month(p_company_id uuid)
returns table (
  invoice_id     uuid,
  invoice_number text,
  service_month  date,
  recognised_in  date,
  amount         numeric,
  reason         text
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- tenant guard [claimed, 0287]: p_company_id IS the caller's tenant claim.
  --
  -- This is a CALL, not a comment. The first draft of this migration wrote the
  -- claim as a comment on a `language sql` body and tenant_guard_gaps() went
  -- from 0 to 1 — the same defect 0316 shipped, caught by the same detector.
  -- All three sibling detectors that ledger_checks reads
  -- (closed_period_intrusions, alert_delivery_gaps, negative_custodian_balances)
  -- are SECURITY DEFINER and call assert_same_company; this one matches them.
  if p_company_id is not null then perform public.assert_same_company(p_company_id); end if;

  return query
  with recognised as (
    select je.source_id as invoice_id,
           je.posting_period,
           sum(jl.credit - jl.debit) as net
      from public.journal_entries je
      join public.journal_lines jl on jl.journal_entry_id = je.id
      join public.chart_of_accounts a on a.id = jl.account_id
     where je.company_id = p_company_id
       and je.source_table = 'invoices'
       and a.account_type = 'revenue'
     group by je.source_id, je.posting_period
    having sum(jl.credit - jl.debit) <> 0
  )
  select i.id,
         i.invoice_number,
         date_trunc('month', i.period_start)::date,
         r.posting_period,
         r.net,
         case
           when i.period_start is null
             then 'the invoice states no service month, so where its revenue belongs cannot be checked'
           else 'revenue recognised in a period other than the service month'
         end
    from recognised r
    join public.invoices i on i.id = r.invoice_id
   where i.company_id = p_company_id
     and (
       i.period_start is null
       or r.posting_period <> date_trunc('month', i.period_start)::date
     )
   order by i.invoice_number, r.posting_period;
end;
$fn$;

comment on function public.revenue_outside_service_month(uuid) is
  '0324: invoices whose revenue is recognised anywhere other than their service month (A4), plus invoices with revenue posted and no period_start at all. Nets credit minus debit per period so a reversal cancels the entry it reverses instead of counting as a second recognition.';

grant execute on function public.revenue_outside_service_month(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Wire it, in the migration that adds it.
--
-- Surgery against the LIVE definition. Restating ledger_checks from a copy is
-- how 0286 and 0288 silently dropped two checks, and 0318 had to put them back.
-- The canary is READ and incremented by this migration's own delta: the base is
-- a reading, the delta is the migration's property (0304/0310). Dev and
-- production do not hold the same number — 26 and 28 — so a literal would be
-- wrong on one of them.
-- ---------------------------------------------------------------------------
do $surgery$
declare
  v_src text;
  v_anchor constant text :=
'      from public.closed_period_intrusions(p_company_id)
  )
  select * from real_checks';
  v_new constant text :=
'      from public.closed_period_intrusions(p_company_id)
    union all
    -- 0324. Revenue belongs to the service month (A4).
    -- ar_control_equals_open_invoices cannot see a breach of this: both sides
    -- of the entry move together, so the wrong month leaves it agreeing.
    select ''revenue_recognised_in_service_month''::text,
           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0
      from public.revenue_outside_service_month(p_company_id)
  )
  select * from real_checks';
  v_hits int;
  v_n    int;
begin
  select pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure) into v_src;

  if position('revenue_recognised_in_service_month' in v_src) > 0 then
    raise notice '0324: already wired, leaving ledger_checks alone';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then
    raise exception
      '0324 FAILED: the closed_period_intrusions anchor appears % times in ledger_checks, expected exactly 1 — do not guess where the check belongs', v_hits;
  end if;
  v_src := replace(v_src, v_anchor, v_new);

  -- The canary, read rather than assumed.
  v_n := (regexp_match(v_src, 'select (\d+)::numeric n\) e \(n\)'))[1]::int;
  if v_n is null then
    raise exception '0324 FAILED: the canary is not in the single-number shape 0302 left it — do not guess';
  end if;
  v_src := regexp_replace(v_src, 'select \d+::numeric n\) e \(n\)',
                          'select ' || (v_n + 1) || '::numeric n) e (n)');

  execute v_src;
  raise notice '0324: canary % -> %', v_n, v_n + 1;
end
$surgery$;

-- ---------------------------------------------------------------------------
-- Proof.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_co      uuid;
  v_inv     record;
  v_rows    int;
  v_found   int;
  v_outcome text;
  v_bad     date;
begin
  -- The check is present, and the canary agrees with the new count, on EVERY
  -- company. A canary that is green on one company and red on another is how
  -- 0301's bump was noticed.
  select count(*) into v_rows
    from public.companies c
   cross join lateral public.ledger_checks(c.id) r
   where r.check_name = 'revenue_recognised_in_service_month';
  if v_rows <> (select count(*) from public.companies) then
    raise exception '0324 FAILED: the new check appears for % of % companies', v_rows, (select count(*) from public.companies);
  end if;

  select count(*) into v_rows
    from public.companies c
   cross join lateral public.ledger_checks(c.id) r
   where r.check_name = 'checks_evaluated' and not r.passed;
  if v_rows <> 0 then
    raise exception '0324 FAILED: the canary is red on % companies — the bump and the check disagree', v_rows;
  end if;

  -- The detector is silent right now, on real data.
  select count(*) into v_rows
    from public.companies c
   cross join lateral public.revenue_outside_service_month(c.id) d;
  if v_rows <> 0 then
    raise exception '0324 FAILED: % existing recognitions are already outside their service month; investigate before installing the check', v_rows;
  end if;

  -- AND IT IS NOT SILENT ON EVERYTHING. A detector that returns nothing on
  -- every input is green for the wrong reason (§9.11). Post revenue against a
  -- real invoice in the WRONG month and require the detector to name it, then
  -- unwind through the transaction — never through a compensating write (0321).
  select i.company_id, i.id, i.invoice_number, i.period_start, i.branch_id, i.client_id
    into v_inv
    from public.invoices i
   where i.period_start is not null
   order by i.period_start desc
   limit 1;
  if v_inv.id is null then
    raise exception '0324 FAILED: no invoice states a service month, so the detector was never exercised';
  end if;
  v_co  := v_inv.company_id;
  v_bad := (date_trunc('month', v_inv.period_start) - interval '1 month')::date;

  begin
    perform public.post_journal(
      v_co, v_bad,
      '0324 probe: revenue in the wrong month',
      'invoices', v_inv.id, false,
      jsonb_build_array(
        jsonb_build_object('key', 'ar', 'debit', 500, 'credit', 0,
                           'client_id', v_inv.client_id),
        jsonb_build_object('key', 'revenue_security', 'debit', 0, 'credit', 500,
                           'client_id', v_inv.client_id)
      ),
      v_inv.branch_id
    );

    select count(*) into v_found
      from public.revenue_outside_service_month(v_co) d
     where d.invoice_id = v_inv.id and d.recognised_in = v_bad;
    if v_found <> 1 then
      raise exception '0324 FAILED: revenue posted to % against an invoice whose service month is % was not detected (% rows)',
        v_bad, date_trunc('month', v_inv.period_start)::date, v_found;
    end if;

    raise exception 'PROBE_ROLLBACK';
  exception when others then
    v_outcome := sqlerrm;
  end;

  if v_outcome <> 'PROBE_ROLLBACK' then
    raise exception '0324 FAILED (detector probe): %', v_outcome;
  end if;

  -- And it is quiet again once the probe is gone.
  select count(*) into v_rows
    from public.companies c
   cross join lateral public.revenue_outside_service_month(c.id) d;
  if v_rows <> 0 then
    raise exception '0324 FAILED: the probe left % rows behind', v_rows;
  end if;

  -- The gap-finder must still be empty. This migration's first draft made it 1
  -- by writing the tenant guard as a comment, and nothing else in the proof
  -- would have noticed — the check was green, the detector worked, and the
  -- boundary was missing. Asserting it here means the next detector cannot
  -- repeat it quietly.
  select count(*) into v_rows from public.tenant_guard_gaps();
  if v_rows <> 0 then
    raise exception '0324 FAILED: tenant_guard_gaps() reports % gaps; a detector added here must carry a real assert_same_company call, not a comment claiming one', v_rows;
  end if;

  raise notice '0324 OK: check wired on every company, detector silent on real data and loud on a wrong-month posting, gap-finder still empty';
end
$proof$;
