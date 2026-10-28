-- 0580 — a Lahore client clearance can be declared whatever the month's run
--
-- Shayan, 28 Oct 2026: "yes do it for lahore" — a screen to clear a Lahore
-- client himself (0576's mechanism: declare the client's row, then post it to
-- the partners outside the run).
--
-- declare_region_profit refused any declaration in a month whose run is
-- POSTED ("reverse it first"). That is right for a whole-region figure, which
-- the run carries. It is wrong for a client clearance, which the run never
-- carries (0576: a posted row is left out of partnership_allocation) and which
-- posts on its own journal — September's five Lahore clearances went in beside
-- September's posted run. So the refusal now applies to whole-region rows only.
-- (declare_region_profit has several authors — 0537, 0573, 0576: surgery,
-- anchor asserted once.)
--
-- Asserted: a client row can be declared in a posted month and a whole-region
-- row still cannot — each read from its own refusal or success, inside a block
-- rolled back by a sentinel whose message is checked.

do $surgery$
declare
  v_def text := pg_get_functiondef('public.declare_region_profit(uuid, date, numeric, text, uuid, numeric)'::regprocedure);
  v_anchor constant text := $a$  if exists (select 1 from public.profit_allocation_runs r where r.company_id = v_company and r.period_month = v_m and r.status = 'POSTED') then$a$;
  v_n int;
begin
  if position('0580' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0580 REFUSED: the posted-run anchor appears % times in declare_region_profit.', v_n; end if;
  execute replace(v_def, v_anchor,
    $r$  -- 0580: a client clearance posts outside the run, so a posted run does not bar it.
  if p_client_id is null and exists (select 1 from public.profit_allocation_runs r where r.company_id = v_company and r.period_month = v_m and r.status = 'POSTED') then$r$);
end $surgery$;

do $test$
declare v_msg text; v_ok boolean := false;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'role', 'authenticated')::text, true);   -- Shayan Ahmed
  begin
    -- Madison Square Mall (Lahore), September 2026 — a posted month
    perform public.declare_region_profit('a46fd702-8796-4858-b338-142628ce33cf', '2026-09-01', 1, '0580 test', 
      (select id from public.clients where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' and name = 'Madison Square Mall'), 0);
    v_ok := true;
    begin
      perform public.declare_region_profit('a46fd702-8796-4858-b338-142628ce33cf', '2026-09-01', 1, '0580 test', null, 0);
      raise exception '0580 REFUSED: a whole-region row was accepted in a posted month.';
    exception when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like '0580 REFUSED%' then raise; end if;
      if v_msg not like '%already declared per client%' and v_msg not like '%is posted%' then
        raise exception '0580 REFUSED: the whole-region refusal said "%".', v_msg;
      end if;
    end;
    raise exception '0580-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0580-SENTINEL' then raise; end if;
  end;
  if not v_ok then raise exception '0580 REFUSED: the client clearance was not accepted.'; end if;
end $test$;
