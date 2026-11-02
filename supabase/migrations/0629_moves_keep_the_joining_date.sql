-- 0629 — moving a guard between clients keeps his joining date and history.
--
-- WHAT HAPPENED (found 2 Nov 2026, Ms. Yasmin Yousaf's October board). Waqas
-- Ahmed (GGS-00647) worked all of October at Regent 1. On 2 Nov he was moved to
-- Ms. Yasmin Yousaf by marking him RESIGNED (last working day 31 Oct) and two
-- minutes later RE-HIRING him there from 1 Nov. A re-hire starts a new
-- employment, so rehire_guard set his joining date 1 Oct -> 1 Nov, closed the
-- Regent 1 posting as a "separation", opened the new one as a "new_hire", and
-- left his contract slot pointing at Regent 1's line. The Monthly Board (fixed in
-- the app the same day) then drew his Regent 1 days on Ms. Yasmin's sheet.
--
-- THE SAME DAMAGE THROUGH THE PROPER BUTTON. Assignments -> Transfer calls
-- change_category, which ALSO wrote join_date = the move date and opened the new
-- posting as "new_hire". So even a correctly entered transfer reset a guard's
-- joining date. The audit log shows such resets (e.g. 1 Sep 2026 for guards who
-- joined in May); they are listed for Shayan to review, not changed here —
-- some of those edits were deliberate corrections and only he can tell which.
--
-- WHAT THIS CHANGES
--   1. change_category (Transfer): keeps an existing joining date
--      (coalesce(join_date, effective date)) and records a move from an existing
--      posting as reason 'transfer', not 'new_hire'. A guard's first posting is
--      still 'new_hire' and still sets an empty joining date.
--   2. rehire_guard: REFUSES a re-hire that starts within 7 days of the guard's
--      last working day — that is a move, not a new employment — and names the
--      Transfer action instead. A genuine re-hire after a real break is unchanged.
--      It also now points the guard's contract slot at the new line (it left the
--      old client's line, so the guard still counted against the old post).
--   3. Waqas Ahmed repaired (named approval): joining date back to 1 Oct 2026,
--      re-hire count back to 0, both postings recorded as a transfer, his slot
--      moved to Ms. Yasmin's line (the one Sikandar Hayat vacated on 31 Oct), and
--      a lifecycle note saying why.
--
-- NOT CHANGED: Waqas has NO salary recorded anywhere (hired 13 Oct without one),
-- so October pay computes 0 for 31 worked days. The figure is Shayan's to give.
-- Muhammad Latif (GGS-00421) left Sweet Palace on 19 Oct and was re-hired at
-- Regent 1 from 1 Nov — a 12-day break, so possibly a real one; left as is,
-- his October pay computes normally.
--
-- SURGERY: change_category and rehire_guard have each been edited by more than
-- one migration, so they are amended against the live definition, each anchor
-- asserted to appear exactly once.

do $surgery$
declare
  v_src text; v_cnt int;
  procedure_anchor text;
begin
  -- ── 1. change_category ──
  v_src := pg_get_functiondef('public.change_category(uuid,text,uuid,uuid,date,uuid)'::regprocedure);

  procedure_anchor := 'values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff, ''new_hire'');';
  v_cnt := (length(v_src) - length(replace(v_src, procedure_anchor, ''))) / length(procedure_anchor);
  if v_cnt <> 1 then raise exception '0629 REFUSED: change_category posting anchor found % times.', v_cnt; end if;
  v_src := replace(v_src, procedure_anchor,
    'values (v_company, p_guard_id, p_new_client_id, p_contract_line_id, v_site, v_eff,
            -- 0629: a move from an existing posting is a transfer, not a new hire.
            case when v_start is not null then ''transfer'' else ''new_hire'' end);');

  procedure_anchor := '           join_date = v_eff,';
  v_cnt := (length(v_src) - length(replace(v_src, procedure_anchor, ''))) / length(procedure_anchor);
  if v_cnt <> 1 then raise exception '0629 REFUSED: change_category join_date anchor found % times.', v_cnt; end if;
  v_src := replace(v_src, procedure_anchor,
    '           -- 0629: a move keeps the joining date; only an empty one is set.
           join_date = coalesce(join_date, v_eff),');
  execute v_src;

  -- ── 2. rehire_guard ──
  v_src := pg_get_functiondef('public.rehire_guard(uuid,date,uuid,uuid,uuid)'::regprocedure);

  procedure_anchor := '  if e.blacklisted then
    raise exception ''Guard is blacklisted and cannot be rehired'';
  end if;';
  v_cnt := (length(v_src) - length(replace(v_src, procedure_anchor, ''))) / length(procedure_anchor);
  if v_cnt <> 1 then raise exception '0629 REFUSED: rehire_guard blacklist anchor found % times.', v_cnt; end if;
  v_src := replace(v_src, procedure_anchor, procedure_anchor || '
  -- 0629: starting again within a week of the last working day is a MOVE between
  -- clients, not a new employment. A re-hire resets the joining date and closes
  -- the old posting as a separation; Transfer keeps both. (Waqas Ahmed, 2 Nov 2026.)
  if e.last_working_day is not null and p_join_date <= e.last_working_day + 7 then
    raise exception ''% stopped work on % and would start again on %. That is a move between clients, not a re-hire: use Transfer on the Assignments page, which keeps the joining date and history. Nothing has been recorded.'',
      e.full_name, to_char(e.last_working_day, ''DD Mon YYYY''), to_char(p_join_date, ''DD Mon YYYY'')
      using errcode = ''23514'';
  end if;');

  procedure_anchor := '    rehire_count      = rehire_count + 1,';
  v_cnt := (length(v_src) - length(replace(v_src, procedure_anchor, ''))) / length(procedure_anchor);
  if v_cnt <> 1 then raise exception '0629 REFUSED: rehire_guard rehire_count anchor found % times.', v_cnt; end if;
  v_src := replace(v_src, procedure_anchor, procedure_anchor || '
    -- 0629: the slot follows the new posting (it used to stay on the old client''s line).
    contract_line_id  = p_contract_line_id,
    contract_id       = (select cl.contract_id from public.contract_lines cl where cl.id = p_contract_line_id),');
  execute v_src;
end $surgery$;

-- ── 3. Waqas Ahmed (GGS-00647): the move recorded as a move ──
do $repair$
declare
  v_emp  constant uuid := '2171026a-56dc-46cf-960f-718701f89e0f';
  v_old  constant uuid := 'aa77915d-24be-4672-9dcd-91b04955f25d';  -- Regent 1, 1–31 Oct
  v_new  constant uuid := '3b59b44b-f36d-4529-902d-0a059db9d0a8';  -- Ms. Yasmin, from 1 Nov
  v_line constant uuid := '2f6063f7-1254-4628-9e8a-6b8b0d7bed1e';  -- Ms. Yasmin's guard line
  v_n int;
begin
  if not exists (select 1 from public.employees where id = v_emp and join_date = '2026-11-01' and rehire_count = 1 and lifecycle_state = 'active') then
    raise exception '0629 REFUSED: Waqas Ahmed is not in the state this repair expects.';
  end if;
  update public.deployments set reason = 'transfer', updated_at = now()
   where id = v_old and guard_id = v_emp and end_date = '2026-10-31' and reason = 'separation';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0629 REFUSED: expected Waqas''s Regent 1 posting, changed %.', v_n; end if;
  update public.deployments set reason = 'transfer', contract_line_id = v_line, updated_at = now()
   where id = v_new and guard_id = v_emp and start_date = '2026-11-01' and end_date is null and reason = 'new_hire';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0629 REFUSED: expected Waqas''s Ms. Yasmin posting, changed %.', v_n; end if;
  update public.employees
     set join_date = '2026-10-01', rehire_count = 0,
         contract_line_id = v_line, contract_id = (select contract_id from public.contract_lines where id = v_line),
         updated_at = now()
   where id = v_emp;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception '0629 REFUSED: expected to repair Waqas Ahmed, changed %.', v_n; end if;
  insert into public.employee_lifecycle_events (company_id, employee_id, from_state, to_state, reason, changed_by, notes)
  select company_id, id, 'active', 'active', 'Correction (0629)', null,
         'Moved from Regent 1 to Ms. Yasmin Yousaf on 1 Nov 2026. It was entered on 2 Nov as a resignation and a re-hire, which reset the joining date to 1 Nov; restored to 1 Oct 2026 (approved by Shayan, 2 Nov 2026).'
    from public.employees where id = v_emp;
end $repair$;

-- ── Tests (rolled back) ──
do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_waqas constant uuid := '2171026a-56dc-46cf-960f-718701f89e0f';
  v_sikandar constant uuid := '3b8bcd71-2afe-4452-a8ab-860221528298';
  v_regent constant uuid := 'c590b2cd-a33b-439c-8fb0-a0a45fd579ff';
  v_yasmin constant uuid := '0ea8da1b-f29d-487b-a572-1bc1ea9e194f';
  v_msg text; v_ran int := 0; r record;
begin
  -- The repair landed (outside the sentinel: it is the migration's own write).
  select * into r from public.employees where id = v_waqas;
  if r.join_date <> '2026-10-01' or r.rehire_count <> 0 or r.contract_line_id <> '2f6063f7-1254-4628-9e8a-6b8b0d7bed1e' then
    raise exception '0629 REFUSED: Waqas reads join %, rehires %, line %.', r.join_date, r.rehire_count, r.contract_line_id;
  end if;
  v_ran := v_ran + 1;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);

    -- 1. Transfer keeps the joining date and records a transfer.
    perform public.change_category(v_waqas, 'client', v_regent, null, current_date, null);
    select * into r from public.employees where id = v_waqas;
    if r.join_date <> '2026-10-01' then raise exception '0629 REFUSED: a transfer set the joining date to %.', r.join_date; end if;
    if not exists (select 1 from public.deployments where guard_id = v_waqas and client_id = v_regent and start_date = current_date and end_date is null and reason = 'transfer') then
      raise exception '0629 REFUSED: the transfer''s new posting is not a transfer.';
    end if;
    v_ran := v_ran + 1;

    -- 2. A re-hire within a week of the last working day is refused, by message.
    v_msg := null;
    begin perform public.rehire_guard(v_sikandar, '2026-11-03', v_yasmin, null, null);
    exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg <> 'Sikandar Hayat stopped work on 31 Oct 2026 and would start again on 03 Nov 2026. That is a move between clients, not a re-hire: use Transfer on the Assignments page, which keeps the joining date and history. Nothing has been recorded.' then
      raise exception '0629 REFUSED: a 3-day re-hire got "%".', v_msg;
    end if;
    v_ran := v_ran + 1;

    -- 3. A genuine re-hire after a real break still works, and moves the slot.
    perform public.rehire_guard(v_sikandar, '2026-11-20', v_yasmin, '2f6063f7-1254-4628-9e8a-6b8b0d7bed1e', null);
    select * into r from public.employees where id = v_sikandar;
    if r.join_date <> '2026-11-20' or r.lifecycle_state <> 'active' or r.contract_line_id <> '2f6063f7-1254-4628-9e8a-6b8b0d7bed1e' then
      raise exception '0629 REFUSED: a real re-hire reads join %, state %, line %.', r.join_date, r.lifecycle_state, r.contract_line_id;
    end if;
    v_ran := v_ran + 1;

    if v_ran <> 4 then raise exception '0629 REFUSED: % of 4 assertions ran.', v_ran; end if;
    raise exception '0629-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0629-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0629 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0629 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
end $test$;
