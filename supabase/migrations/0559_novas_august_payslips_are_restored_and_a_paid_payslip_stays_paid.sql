-- 0559 — Nova's August payslips are restored, and a paid payslip stays paid
--
-- WHAT HAPPENED. At 2026-10-26 10:20:08 UTC Shayan opened Nova Group's August
-- payroll "just to check something". The screen's automatic "create the
-- missing payslips" save ran while the rows already said August but still held
-- September's payslips and advances (fixed in the frontend, 62430d5), and its
-- upsert overwrote what was there. In one transaction:
--   * 30 August payslips were rewritten — 29 of them PAID on 29 Sep 2026
--     (PKR 639,872 in cash from M. Zamir Khan) were set back to Pending,
--     amount_paid 0, with recomputed figures; Muhammad Abid's took his
--     9 Oct advance of 26,000 (25,944 of it), leaving 56 for September;
--   * the journal followed: the 29 disbursements were REVERSED (639,872 back
--     into Zamir's cash on the books — money that was paid out), the accrual
--     for 27 was reversed and 36 were re-posted at the new figures;
--   * 9 August payslips were CREATED for Nova guards with NO August attendance
--     at all, their days copied from September.
-- No money table moved (apply_money_delta was never called) and there is no
-- August partnership run, so nothing downstream of the ledger is affected.
--
-- THE REPAIR — a restoration of recorded values, not a new money entry:
--   1. each of the 30 rows gets back the exact value every changed column had
--      before 10:20:08, read from its own audit_log row; refused if anything
--      has touched the row since;
--   2. the 9 created rows are deleted; refused unless each is August, unpaid,
--      created in that transaction, for a guard with no August attendance;
--   3. the journal trigger re-posts. ASSERTED: for every account and client,
--      the net of every journal line sourced from these 39 payslips equals the
--      net before 10:20:08 — the books are back to 29 Sep, not just "close".
--
-- THE GUARD — so no screen can do this again. A paid payslip cannot be set
-- unpaid, nor have its amount_paid lowered, by any write except
-- reverse_payslip_disbursement (0503), the one path that also returns the
-- money. That function raises a transaction-local flag before its update;
-- everything else is refused with the reason. It was the only function in the
-- database that lowers either (checked 2026-10-26).

-- ── 1–3. The restore ─────────────────────────────────────────────────────────
do $mig$
declare
  c_at constant timestamptz := '2026-10-26 10:20:08.19512+00';
  v_keys constant text[] := array['amount_paid','disbursed','status','disbursed_at','final_salary','net_salary',
                                  'present_days','leave_days','advance','base_salary','per_day_salary'];
  r record; v_n int; v_bad int; v_patch jsonb; v_after jsonb;
begin
  create temp table _0559_ids on commit drop as
    select record_id::uuid id, action::text action, changes
      from public.audit_log where table_name = 'payslips' and changed_at = c_at;

  -- Replay: once restored, the updated rows no longer carry the 10:20 values.
  if not exists (select 1 from public.payslips p join _0559_ids i on i.id = p.id
                  where i.action = 'update' and p.updated_at = c_at)
     and not exists (select 1 from public.payslips p join _0559_ids i on i.id = p.id where i.action = 'insert') then
    raise notice '0559: already restored.';
  else
    if (select count(*) from _0559_ids where action = 'update') <> 30
       or (select count(*) from _0559_ids where action = 'insert') <> 9 then
      raise exception '0559 REFUSED: expected 30 updates and 9 inserts at 10:20:08, found % and %.',
        (select count(*) from _0559_ids where action = 'update'), (select count(*) from _0559_ids where action = 'insert');
    end if;
    if exists (select 1 from _0559_ids i, jsonb_object_keys(i.changes) k where i.action = 'update' and k <> all (v_keys || array['updated_at'])) then
      raise exception '0559 REFUSED: the 10:20 updates changed a column this restore does not cover.';
    end if;
    -- Nothing may have touched them since.
    select count(*) into v_bad from _0559_ids i
     where exists (select 1 from public.audit_log b where b.record_id::text = i.id::text and b.changed_at > c_at);
    if v_bad > 0 then raise exception '0559 REFUSED: % of the payslips were changed again after 10:20:08.', v_bad; end if;
    if exists (select 1 from public.payslips p join _0559_ids i on i.id = p.id where coalesce(p.adjustment_carried, 0) <> 0) then
      raise exception '0559 REFUSED: a payslip carries an adjustment; restoring disbursed would settle it.';
    end if;
    -- The created rows are what they appear to be.
    select count(*) into v_bad from _0559_ids i join public.payslips p on p.id = i.id
     where i.action = 'insert'
       and not (p.period_month = '2026-08-01' and not p.disbursed and coalesce(p.amount_paid, 0) = 0
                and not exists (select 1 from public.attendance_records ar where ar.employee_id = p.employee_id
                                 and ar.attendance_date between '2026-08-01' and '2026-08-31'));
    if v_bad > 0 then raise exception '0559 REFUSED: % created payslip(s) are not unpaid August rows without August attendance.', v_bad; end if;

    -- The ledger as it stood before 10:20:08, per account and client.
    create temp table _0559_before on commit drop as
      select jl.account_id, jl.client_id, sum(jl.debit - jl.credit) net
        from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
       where je.source_id in (select id from _0559_ids) and je.created_at < c_at
       group by 1, 2;

    -- 1. Restore, row by row, column by column.
    for r in select i.id, i.changes from _0559_ids i where i.action = 'update' loop
      select jsonb_object_agg(k, r.changes -> k -> 'before'), jsonb_object_agg(k, r.changes -> k -> 'after')
        into v_patch, v_after
        from jsonb_object_keys(r.changes) k where k <> 'updated_at';
      -- Each changed column must still hold what 10:20 wrote.
      if exists (select 1 from public.payslips p, jsonb_each(v_after) a
                  where p.id = r.id
                    and case when jsonb_typeof(a.value) = 'number'
                             then (to_jsonb(p) ->> a.key)::numeric is distinct from (a.value #>> '{}')::numeric
                             else (to_jsonb(p) -> a.key) is distinct from a.value end) then
        raise exception '0559 REFUSED: payslip % no longer holds the 10:20 values.', r.id;
      end if;
      update public.payslips p set
        (amount_paid, disbursed, status, disbursed_at, final_salary, net_salary,
         present_days, leave_days, advance, base_salary, per_day_salary)
        = (select x.amount_paid, x.disbursed, x.status, x.disbursed_at, x.final_salary, x.net_salary,
                  x.present_days, x.leave_days, x.advance, x.base_salary, x.per_day_salary
             from jsonb_populate_record(null::public.payslips, to_jsonb(p) || v_patch) x)
       where p.id = r.id;
      get diagnostics v_n = row_count;
      if v_n <> 1 then raise exception '0559 REFUSED: restoring % touched % rows.', r.id, v_n; end if;
    end loop;

    -- 2. Delete the rows that should never have existed.
    delete from public.payslips where id in (select id from _0559_ids where action = 'insert');
    get diagnostics v_n = row_count;
    if v_n <> 9 then raise exception '0559 REFUSED: deleted % created payslips, expected 9.', v_n; end if;

    -- 3. The books are back where they were — every account, every client.
    select count(*) into v_bad from (
      select coalesce(b.account_id, a.account_id) acc, coalesce(b.net, 0) b, coalesce(a.net, 0) a
        from _0559_before b
        full join (select jl.account_id, jl.client_id, sum(jl.debit - jl.credit) net
                     from public.journal_entries je join public.journal_lines jl on jl.journal_entry_id = je.id
                    where je.source_id in (select id from _0559_ids)
                    group by 1, 2) a
          on a.account_id = b.account_id and a.client_id is not distinct from b.client_id) d
     where round(d.b, 2) <> round(d.a, 2);
    if v_bad > 0 then raise exception '0559 REFUSED: % account/client net(s) differ from before 10:20:08.', v_bad; end if;
  end if;

  -- Whatever the path: the 29 are paid, Abid's August recovered no advance.
  if (select count(*) from public.payslips p join _0559_ids i on i.id = p.id
       where i.action = 'update' and p.disbursed) <> 29 then
    raise exception '0559 REFUSED: the 29 August payslips paid on 29 Sep are not all paid.';
  end if;
  if (select advance from public.payslips where id = 'b02b0f58-c86f-4e39-ad18-0055928320df') <> 0 then
    raise exception '0559 REFUSED: Muhammad Abid''s August payslip still recovers an advance.';
  end if;
end $mig$;

-- ── The guard ────────────────────────────────────────────────────────────────
create or replace function public.enforce_paid_payslip_stays_paid()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
  if old.disbursed
     and (not new.disbursed or coalesce(new.amount_paid, 0) < coalesce(old.amount_paid, 0))
     and coalesce(current_setting('bastion.payslip_reversal', true), '') <> 'on' then
    raise exception 'This payslip is paid (PKR %) and cannot be set back to unpaid by a save. To undo a payment, reverse it — that also returns the money to where it left.',
      to_char(coalesce(old.amount_paid, 0), 'FM999,999,999')
      using errcode = 'P0001', hint = '0559: only reverse_payslip_disbursement may un-pay a payslip.';
  end if;
  return new;
end $fn$;
comment on function public.enforce_paid_payslip_stays_paid() is
  'DECIDED 2026-10-26 (0559): a paid payslip is set unpaid, or its amount_paid lowered, only by reverse_payslip_disbursement, '
  'which raises bastion.payslip_reversal for its transaction. Added after a screen save un-paid 29 of Nova''s August payslips.';
drop trigger if exists trg_payslip_paid_stays_paid on public.payslips;
create trigger trg_payslip_paid_stays_paid before update on public.payslips
  for each row execute function public.enforce_paid_payslip_stays_paid();

-- reverse_payslip_disbursement has several authors (0503, 0506, 0507, 0541,
-- 0542): surgery on its one payslip update, anchor asserted once.
do $surgery$
declare
  v_def text := pg_get_functiondef('public.reverse_payslip_disbursement(uuid, text, boolean, text)'::regprocedure);
  v_anchor constant text := 'update public.payslips';
  v_n int;
begin
  if position('bastion.payslip_reversal' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0559 REFUSED: reverse_payslip_disbursement updates payslips % times.', v_n; end if;
  execute replace(v_def, v_anchor,
    'perform set_config(''bastion.payslip_reversal'', ''on'', true);  -- 0559: the one path that may un-pay a payslip' || E'\n  ' || v_anchor);
end $surgery$;

-- The guard refuses a save and admits the reversal.
do $proof$
declare v_id uuid; v_msg text;
begin
  select id into v_id from public.payslips where disbursed and amount_paid > 0 order by updated_at desc limit 1;
  begin
    update public.payslips set disbursed = false, amount_paid = 0 where id = v_id;
    raise exception '0559 REFUSED: the guard let a paid payslip be un-paid.';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This payslip is paid%cannot be set back to unpaid by a save%' then
      raise exception '0559 REFUSED: the guard refused with the wrong message: %', v_msg;
    end if;
  end;
  if position('set_config(''bastion.payslip_reversal'', ''on'', true)'
              in pg_get_functiondef('public.reverse_payslip_disbursement(uuid, text, boolean, text)'::regprocedure)) = 0 then
    raise exception '0559 REFUSED: reverse_payslip_disbursement does not raise the flag.';
  end if;
end $proof$;
