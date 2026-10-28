-- 0577 — every partner-ledger line names its counterpart
--
-- Shayan, 28 Oct 2026, of Shujaat's ledger: "make every line readable". 0575
-- named the profit shares, the expenses and the bank; four kinds of line still
-- said nothing of who or what:
--
--   TRANSFER IN            → CASH RECEIVED FROM M. Zamir Khan — <note>
--   TRANSFER OUT           → CASH HANDED TO Gul Rehman — <note>
--   CLIENT CASH — Lexus    → CLIENT CASH — Lexus Tower · GGS-26-LEX-09
--   BANK TRANSFER — Draw…  → BANK TRANSFER (BOAJK) — Drawing   (or the custody
--                            it came out of, for a cash drawing)
--
-- partner_ledger has several authors: surgery, each anchor asserted to appear
-- exactly once. Labels only — no amount, date, sign or column changes.
--
-- Asserted: every partner's ledger keeps its row count and its closing sum;
-- Shujaat's has no bare "TRANSFER IN"/"TRANSFER OUT" left.

do $mig$
declare
  v_def text := pg_get_functiondef('public.partner_ledger(uuid, date, date)'::regprocedure);
  a1 constant text := $a$    select t.date::date, 'TRANSFER IN', t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text, null::uuid$a$;
  r1 constant text := $r$    select t.date::date,   -- 0577: from whom
           'CASH RECEIVED FROM ' || coalesce((select f.name from public.cash_locations f where f.id = t.from_location_id), 'custody')
             || coalesce(' — ' || nullif(btrim(t.notes), ''), ''),
           t.amount, 0::numeric, 'CUSTODY:TRANSFER_IN'::text, null::uuid$r$;
  a2 constant text := $a$    select t.date::date, 'TRANSFER OUT', -t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text, null::uuid$a$;
  r2 constant text := $r$    select t.date::date,   -- 0577: to whom
           'CASH HANDED TO ' || coalesce((select tl.name from public.cash_locations tl where tl.id = t.to_location_id), 'custody')
             || coalesce(' — ' || nullif(btrim(t.notes), ''), ''),
           -t.amount, 0::numeric, 'CUSTODY:TRANSFER_OUT'::text, null::uuid$r$;
  a3 constant text := $a$    select ip.payment_date::date, 'CLIENT CASH — ' || coalesce(c.name, 'client'),$a$;
  r3 constant text := $r$    select ip.payment_date::date, 'CLIENT CASH — ' || coalesce(c.name, 'client')   -- 0577: which invoice
             || coalesce(' · ' || (select i.invoice_number from public.invoices i where i.id = ip.invoice_id), ''),$r$;
  a4 constant text := $a$             when 'CHEQUE' then 'CHEQUE' else 'CASH PAID' end$a$;
  r4 constant text := $r$             when 'CHEQUE' then 'CHEQUE' else 'CASH PAID' end
           -- 0577: from which bank, or out of whose custody
           || coalesce(' (' || (select ba.bank_name from public.bank_accounts ba where ba.id = e.bank_account_id) || ')',
                       ' (' || (select cl.name from public.cash_locations cl where cl.id = e.cash_location_id) || ')', '')$r$;
  v_n int; v_before jsonb; v_after jsonb; v_bare int;
begin
  if position('0577' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if v_n <> 1 then raise exception '0577 REFUSED: the transfer-in anchor appears % times.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if v_n <> 1 then raise exception '0577 REFUSED: the transfer-out anchor appears % times.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a3, ''))) / length(a3);
  if v_n <> 1 then raise exception '0577 REFUSED: the client-cash anchor appears % times.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a4, ''))) / length(a4);
  if v_n <> 1 then raise exception '0577 REFUSED: the drawing anchor appears % times.', v_n; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan, to read the ledgers
  select jsonb_object_agg(p.id, (select jsonb_build_array(count(*), sum(l.remuneration - l.cash_paid)) from public.partner_ledger(p.id) l))
    into v_before from public.partners p where p.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e';

  execute replace(replace(replace(replace(v_def, a1, r1), a2, r2), a3, r3), a4, r4);

  select jsonb_object_agg(p.id, (select jsonb_build_array(count(*), sum(l.remuneration - l.cash_paid)) from public.partner_ledger(p.id) l))
    into v_after from public.partners p where p.company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  if v_after is distinct from v_before then
    raise exception '0577 REFUSED: a partner''s ledger changed its rows or its sum (% → %).', v_before, v_after;
  end if;
  select count(*) into v_bare from public.partner_ledger((select id from public.partners where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Shujaat Mehmood'))
   where particulars in ('TRANSFER IN', 'TRANSFER OUT');
  if v_bare <> 0 then raise exception '0577 REFUSED: % bare TRANSFER lines remain in Shujaat''s ledger.', v_bare; end if;
end $mig$;
