-- 0554 — fuel cards are held by named office staff or partners
--
-- DECIDED 2026-10-23 (Shayan):
--   "only office staff get fuel cards
--    Company float: Zamir: Manager Admin · Zafar: Manager Ops
--    Allowance: CEO; Shujaat Mehmood partner · MD; Col Nauman partner · CFO; Shayan
--    … i have written the opening balance as per attock now it will be according
--    to that add an option to tally fuel cards as well plus i added one card by
--    mistake couldnt delete or edit it. delete that card add these with names and
--    link them … no balance of allowance card to be shown obviously only float cards"
--   Asked and answered the same day: the opening balance's other side is
--   Opening Balance Equity (like the bank openings, 0544); a partner's card is
--   loaded as a drawing on that partner.
--
-- So:
--   * fuel_cards.holder_partner_id: an allowance card is held by an office-staff
--     employee OR a partner (exactly one); a float card may name the office-staff
--     employee who carries it. An employee holder must be office staff.
--   * register_fuel_card (0542, its only author) is restated behind a digest
--     precondition with p_holder_partner_id; update_fuel_card and
--     delete_fuel_card are new — delete only for a card nothing has touched (no
--     load, bill, reading, payslip or ledger line), taking its 1020.NN leaf with it.
--   * fuel_card_balances (0542, only author) names a partner holder too —
--     surgery on two anchors.
--   * The card added by mistake ("Zamir", no number, untouched) is deleted, and
--     the five cards are registered by their last four digits only (never the PIN):
--       float      Manager Admin — Zamir   ••6628  opening 3,502.49
--       float      Manager Ops — Zafar     ••7724  opening 2,277.74
--       allowance  CEO — Shujaat Mehmood   ••8828  (partner)
--       allowance  MD — Col Nauman         ••9923  (partner)
--       allowance  CFO — Shayan            ••0138  (Shayan Ahmed, office staff)
--   * Each float card opens at its Attock figure (Dr the card, Cr 3200, dated
--     23 Oct 2026) with an Attock tally of the same amount, so it starts agreed.
--
-- Asserted: the stray card is gone; five cards with their holders; each float
-- card holds its opening and agrees with Attock; an allowance card cannot be
-- given to a non-office-staff employee (refused with its message).

-- ── holders ──────────────────────────────────────────────────────────────────
alter table public.fuel_cards add column if not exists holder_partner_id uuid references public.partners(id);
-- 0542 required an employee holder on every allowance card; the holder rule
-- now lives in fuel_cards_holder_check (an employee or a partner).
alter table public.fuel_cards drop constraint if exists fuel_cards_allowance_has_no_account;
alter table public.fuel_cards add constraint fuel_cards_allowance_has_no_account check (role <> 'allowance' or coa_account_id is null);
alter table public.fuel_cards drop constraint if exists fuel_cards_holder_check;
alter table public.fuel_cards add constraint fuel_cards_holder_check check (
  (role = 'allowance' and ((holder_employee_id is null) <> (holder_partner_id is null)))
  or (role = 'float' and holder_partner_id is null));
comment on column public.fuel_cards.holder_partner_id is
  'DECIDED 2026-10-23 (0554). A partner''s allowance card (CEO, MD). Loading it is a drawing on that partner '
  '(record_partner_entry). An allowance card has exactly one holder: an office-staff employee or a partner.';

-- One rule for both write paths: an employee holder is office staff.
create or replace function public.assert_fuel_card_holder(p_holder_employee_id uuid)
returns void
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  -- tenant guard [resolved]: owning company from p_holder_employee_id via public.employees
  if p_holder_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_holder_employee_id)); end if;
  if p_holder_employee_id is not null
     and (select category::text from public.employees where id = p_holder_employee_id) is distinct from 'office_staff' then
    raise exception 'Only office staff hold fuel cards. % is not office staff. Nothing has been recorded.',
      (select full_name from public.employees where id = p_holder_employee_id) using errcode = 'P0001';
  end if;
end $function$;
revoke all on function public.assert_fuel_card_holder(uuid) from public, anon;

-- ── register (restated: 0542 is its only author) ─────────────────────────────
do $restate$
begin
  if exists (select 1 from pg_proc where proname = 'register_fuel_card' and pronamespace = 'public'::regnamespace
              and pg_get_function_identity_arguments(oid) like '%p_holder_partner_id%') then
    return;  -- replay
  end if;
  if (select md5(prosrc) from pg_proc where proname = 'register_fuel_card' and pronamespace = 'public'::regnamespace) <> '12aa20052b516f3204b4f6c5757a0ed6' then
    raise exception '0554 REFUSED: register_fuel_card is not the body 0542 wrote; restating would discard an edit.';
  end if;
  drop function public.register_fuel_card(text, text, uuid, uuid, text, text, text);
end $restate$;

create or replace function public.register_fuel_card(
  p_role text, p_label text, p_branch_id uuid default null, p_holder_employee_id uuid default null,
  p_card_last4 text default null, p_provider text default 'Attock', p_notes text default null,
  p_holder_partner_id uuid default null)
returns uuid
language plpgsql security definer set search_path to 'public'
as $function$
  declare v_company uuid; v_parent uuid; v_acct uuid; v_code text; v_id uuid;
  begin
    -- 0542: a float card is company money (accounting.edit); an allowance card
    -- is where a man is paid (payroll.edit).
    if p_role not in ('float', 'allowance') then raise exception 'A fuel card is either a company float or an allowance card. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if auth.uid() is not null and pg_trigger_depth() = 0 then
      perform public.require_perm(case when p_role = 'float' then 'accounting.edit' else 'payroll.edit' end);
    end if;
    perform public.assert_branch_in_company(p_branch_id);
    perform public.assert_branch_writable(p_branch_id);
    -- tenant guard [resolved]: owning company from p_holder_employee_id via public.employees
    if p_holder_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_holder_employee_id)); end if;
    -- tenant guard [resolved]: owning company from p_holder_partner_id via public.partners
    if p_holder_partner_id is not null then perform public.assert_same_company((select company_id from public.partners where id = p_holder_partner_id)); end if;
    -- 0554: only office staff hold fuel cards.
    perform public.assert_fuel_card_holder(p_holder_employee_id);

    v_company := public.current_company_id();
    if v_company is null then
      v_company := coalesce((select company_id from public.branches where id = p_branch_id),
                            (select company_id from public.employees where id = p_holder_employee_id),
                            (select company_id from public.partners where id = p_holder_partner_id));
    end if;
    if v_company is null then raise exception 'No company to register the card under. Nothing has been recorded.' using errcode = 'P0001'; end if;
    if p_label is null or btrim(p_label) = '' then
      raise exception 'Name the card (e.g. "Manager Ops — Zafar"). Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_role = 'allowance' and (p_holder_employee_id is null) = (p_holder_partner_id is null) then
      raise exception 'An allowance card belongs to one person: choose the office-staff member or the partner who holds it. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_role = 'float' and p_holder_partner_id is not null then
      raise exception 'A company float card is carried by office staff, not held by a partner. Nothing has been recorded.' using errcode = 'P0001';
    end if;
    if p_card_last4 is not null and btrim(p_card_last4) !~ '^\d{4}$' then
      raise exception 'Last four digits of the card only — four numbers. Nothing has been recorded.' using errcode = '23514';
    end if;

    if p_role = 'float' then
      v_parent := public.fuel_cards_account(v_company);
      select '1020.' || lpad((coalesce(max(nullif(split_part(account_code, '.', 2), '')::int), 0) + 1)::text, 2, '0')
        into v_code
        from public.chart_of_accounts where company_id = v_company and account_code like '1020.%';
      insert into public.chart_of_accounts
        (company_id, account_code, account_name, account_type, normal_side, parent_id, system_account, active, is_control, notes)
      values (v_company, v_code, 'Fuel card — ' || btrim(p_label), 'asset', 'debit', v_parent, false, true, false,
              'Float on one fuel card; its balance is this account. 0542.')
      returning id into v_acct;
    end if;

    insert into public.fuel_cards (company_id, role, label, provider, card_last4, holder_employee_id, holder_partner_id, branch_id, coa_account_id, notes)
    values (v_company, p_role, btrim(p_label), coalesce(nullif(btrim(p_provider), ''), 'Attock'),
            nullif(btrim(p_card_last4), ''), p_holder_employee_id, p_holder_partner_id, p_branch_id, v_acct, nullif(btrim(p_notes), ''))
    returning id into v_id;
    return v_id;
  end $function$;
revoke all on function public.register_fuel_card(text, text, uuid, uuid, text, text, text, uuid) from public, anon;
grant execute on function public.register_fuel_card(text, text, uuid, uuid, text, text, text, uuid) to authenticated;

-- ── edit ─────────────────────────────────────────────────────────────────────
create or replace function public.update_fuel_card(
  p_fuel_card_id uuid, p_label text, p_card_last4 text, p_holder_employee_id uuid, p_holder_partner_id uuid,
  p_branch_id uuid, p_notes text default null)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare c public.fuel_cards;
begin
  select * into c from public.fuel_cards where id = p_fuel_card_id;
  if c.id is null then raise exception 'No such fuel card. Nothing has been changed.' using errcode = 'P0001'; end if;
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm(case when c.role = 'float' then 'accounting.edit' else 'payroll.edit' end);
  end if;
  -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
  if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
  -- tenant guard [resolved]: owning company from p_holder_partner_id via public.partners
  if p_holder_partner_id is not null then perform public.assert_same_company((select company_id from public.partners where id = p_holder_partner_id)); end if;
  -- tenant guard [resolved]: owning company from p_holder_employee_id via public.employees
  if p_holder_employee_id is not null then perform public.assert_same_company((select company_id from public.employees where id = p_holder_employee_id)); end if;
  perform public.assert_branch_writable(c.branch_id);
  if p_branch_id is not null then perform public.assert_branch_in_company(p_branch_id); perform public.assert_branch_writable(p_branch_id); end if;
  perform public.assert_fuel_card_holder(p_holder_employee_id);
  if p_label is null or btrim(p_label) = '' then raise exception 'Name the card. Nothing has been changed.' using errcode = 'P0001'; end if;
  if p_card_last4 is not null and btrim(p_card_last4) <> '' and btrim(p_card_last4) !~ '^\d{4}$' then
    raise exception 'Last four digits of the card only — four numbers. Nothing has been changed.' using errcode = '23514';
  end if;
  if c.role = 'allowance' and (p_holder_employee_id is null) = (p_holder_partner_id is null) then
    raise exception 'An allowance card belongs to one person: the office-staff member or the partner. Nothing has been changed.' using errcode = 'P0001';
  end if;
  if c.role = 'float' and p_holder_partner_id is not null then
    raise exception 'A company float card is carried by office staff, not held by a partner. Nothing has been changed.' using errcode = 'P0001';
  end if;
  update public.fuel_cards
     set label = btrim(p_label), card_last4 = nullif(btrim(coalesce(p_card_last4, '')), ''),
         holder_employee_id = p_holder_employee_id, holder_partner_id = p_holder_partner_id,
         branch_id = coalesce(p_branch_id, branch_id), notes = nullif(btrim(coalesce(p_notes, '')), ''), updated_at = now()
   where id = c.id;
  if c.coa_account_id is not null then
    update public.chart_of_accounts set account_name = 'Fuel card — ' || btrim(p_label), updated_at = now() where id = c.coa_account_id;
  end if;
end $function$;

-- ── delete: only a card nothing has touched ──────────────────────────────────
create or replace function public.delete_fuel_card(p_fuel_card_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare c public.fuel_cards;
begin
  select * into c from public.fuel_cards where id = p_fuel_card_id;
  if c.id is null then raise exception 'No such fuel card. Nothing has been deleted.' using errcode = 'P0001'; end if;
  if auth.uid() is not null and pg_trigger_depth() = 0 then
    perform public.require_perm(case when c.role = 'float' then 'accounting.edit' else 'payroll.edit' end);
  end if;
  -- tenant guard [resolved]: owning company from p_fuel_card_id via public.fuel_cards
  if p_fuel_card_id is not null then perform public.assert_same_company((select company_id from public.fuel_cards where id = p_fuel_card_id)); end if;
  perform public.assert_branch_writable(c.branch_id);
  if exists (select 1 from public.fuel_card_loads where fuel_card_id = c.id)
     or exists (select 1 from public.fuel_card_readings where fuel_card_id = c.id)
     or exists (select 1 from public.expenses where fuel_card_id = c.id)
     or exists (select 1 from public.payslips where fuel_card_id = c.id)
     or (c.coa_account_id is not null and exists (select 1 from public.journal_lines where account_id = c.coa_account_id)) then
    raise exception 'This card has been used — loaded, billed, tallied or paid onto — so it cannot be deleted. Deactivate it instead. Nothing has been deleted.'
      using errcode = 'P0001';
  end if;
  delete from public.fuel_cards where id = c.id;
  if c.coa_account_id is not null then delete from public.chart_of_accounts where id = c.coa_account_id; end if;
end $function$;

revoke all on function public.update_fuel_card(uuid, text, text, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.update_fuel_card(uuid, text, text, uuid, uuid, uuid, text) to authenticated;
revoke all on function public.delete_fuel_card(uuid) from public, anon;
grant execute on function public.delete_fuel_card(uuid) to authenticated;

-- ── balances name a partner holder ───────────────────────────────────────────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.fuel_card_balances(uuid)'::regprocedure);
  a1 constant text := 'fc.holder_employee_id, e.full_name, fc.branch_id';
  a2 constant text := E'      left join public.employees e on e.id = fc.holder_employee_id\n';
  n int;
begin
  if position('0554' in v_def) > 0 then return; end if;  -- replay
  n := (length(v_def) - length(replace(v_def, a1, ''))) / length(a1);
  if n <> 1 then raise exception '0554 REFUSED: anchor 1 appears % times in fuel_card_balances.', n; end if;
  n := (length(v_def) - length(replace(v_def, a2, ''))) / length(a2);
  if n <> 1 then raise exception '0554 REFUSED: anchor 2 appears % times in fuel_card_balances.', n; end if;
  v_def := replace(v_def, a1, 'fc.holder_employee_id, coalesce(e.full_name, pt.name) /* 0554 */, fc.branch_id');
  v_def := replace(v_def, a2, a2 || E'      left join public.partners pt on pt.id = fc.holder_partner_id\n');
  execute v_def;
end $surgery$;

-- ── the cards ────────────────────────────────────────────────────────────────
do $cards$
declare
  v_br    constant uuid := '87c67763-e53c-4e0c-8362-38cd8abe4bb2';
  v_stray constant uuid := '9efe5585-044e-45e0-ba38-3b12262a0e17';
  v_admin uuid; v_ops uuid; v_card record; v_n int;
begin
  if exists (select 1 from public.fuel_cards where card_last4 in ('6628', '7724', '8828', '9923', '0138')) then
    raise notice '0554: cards already registered — skipped on replay.';
    return;
  end if;
  if exists (select 1 from public.fuel_cards where id = v_stray) then
    perform public.delete_fuel_card(v_stray);
  end if;

  v_admin := public.register_fuel_card('float', 'Manager Admin — Zamir', v_br, '222ed53e-a3f8-47fe-ab4b-52ea35639c70', '6628');
  v_ops   := public.register_fuel_card('float', 'Manager Ops — Zafar',   v_br, 'ccf1ba8f-299e-445c-b38c-e767c36dd5c4', '7724');
  perform public.register_fuel_card('allowance', 'CEO — Shujaat Mehmood', v_br, null, '8828', 'Attock', 'Partner. Loading it is a drawing on him.', '9e53fef6-10f1-42fd-8d27-380d5e038c14');
  perform public.register_fuel_card('allowance', 'MD — Col Nauman',       v_br, null, '9923', 'Attock', 'Partner. Loading it is a drawing on him.', '5b52b367-30bb-4e22-89b1-aea4885b8499');
  perform public.register_fuel_card('allowance', 'CFO — Shayan',          v_br, 'eda1bc30-2b7a-4369-be09-9d20d9b160b2', '0138');

  -- Openings at the Attock figure, tallied the same day.
  for v_card in select * from (values (v_admin, 3502.49::numeric), (v_ops, 2277.74::numeric)) t(id, amt) loop
    perform public.post_journal(
      '7f7899a0-edd2-4491-a40d-f81b54c68d1e', '2026-10-23',
      'Fuel card opening balance per Attock — ' || (select label from public.fuel_cards where id = v_card.id),
      'fuel_card_opening', v_card.id, false,
      jsonb_build_array(
        jsonb_build_object('account_id', (select coa_account_id from public.fuel_cards where id = v_card.id), 'debit', v_card.amt, 'credit', 0),
        jsonb_build_object('key', 'opening_balance_equity', 'debit', 0, 'credit', v_card.amt)),
      v_br);
    perform public.record_fuel_card_reading(v_card.id, '2026-10-23', v_card.amt, 'Opening — Attock portal');
  end loop;

  -- Asserted.
  if exists (select 1 from public.fuel_cards where id = v_stray) then raise exception '0554 REFUSED: the stray card survived.'; end if;
  select count(*) into v_n from public.fuel_cards where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  if v_n <> 5 then raise exception '0554 REFUSED: % cards, expected 5.', v_n; end if;
  if (select balance from public.fuel_card_balances('7f7899a0-edd2-4491-a40d-f81b54c68d1e') where fuel_card_id = v_admin) <> 3502.49
     or (select balance from public.fuel_card_balances('7f7899a0-edd2-4491-a40d-f81b54c68d1e') where fuel_card_id = v_ops) <> 2277.74 then
    raise exception '0554 REFUSED: the float cards do not hold their Attock openings.';
  end if;
  if exists (select 1 from public.fuel_card_portal_gaps('7f7899a0-edd2-4491-a40d-f81b54c68d1e')) then
    raise exception '0554 REFUSED: a float card disagrees with Attock after opening.';
  end if;
  if (select holder_name from public.fuel_card_balances('7f7899a0-edd2-4491-a40d-f81b54c68d1e') where label = 'CEO — Shujaat Mehmood') is distinct from 'Shujaat Mehmood' then
    raise exception '0554 REFUSED: the CEO card does not name its partner.';
  end if;
  begin
    perform public.register_fuel_card('allowance', 'proof', v_br, (select id from public.employees where category::text = 'client' limit 1), '1234');
    raise exception '0554 REFUSED: a guard was given a fuel card.';
  exception when others then
    if sqlerrm not like 'Only office staff hold fuel cards.%' then raise; end if;
  end;
end $cards$;

do $guards$
begin
  if exists (select 1 from public.tenant_guard_gaps() where function_name in ('register_fuel_card', 'update_fuel_card', 'delete_fuel_card', 'assert_fuel_card_holder')) then
    raise exception '0554 REFUSED: tenant_guard_gaps names a fuel card function: %',
      (select json_agg(g) from public.tenant_guard_gaps() g where g.function_name like '%fuel%');
  end if;
  raise notice '0554: five cards registered with their holders; float openings 3,502.49 and 2,277.74 agree with Attock.';
end $guards$;
