-- 0639 — leave carries only where the client says so
--
-- DECIDED 2026-11-04 (Shayan): carry-forward is chosen PER CLIENT; it is OFF
-- for every client for now; guards of a client that is switched on may be given
-- a named OPENING BALANCE; and a guard FORFEITS HIS BANK on arrival at a client
-- that does not carry.
--
-- WHAT WAS WRONG. 0438 built the leave ledger with an unconditional carry: the
-- running balance in leave_periods_all is threaded from each period's closing
-- into the next period's opening, and the function never looks at the client.
-- clients.leave_carry_forward — the per-client switch that predates 0438 and is
-- FALSE on all 52 clients on production — decided nothing. The payroll screen's
-- own carry path (carriedAllowance in PayrollManagement.tsx) is the only thing
-- that ever read the flag, and PayrollManagement.tsx:952 prefers
-- leave_period_summary over it whenever the guard has attendance in the month,
-- which for a guard is always. So the flag was unreachable and carry was
-- universal.
--
-- WHAT IT HAD COST, read off production before this file was written:
--
--     period     guards carrying   days carried in   max on one guard
--     2026-09              0              0                 0
--     2026-10             67            138                 4
--     2026-11             59            227                 8
--
-- 29 leave days in October and 5 so far in November were paid ONLY because of
-- the carried opening (~PKR 30,770 and ~PKR 4,733). Nobody has reached the
-- 15-day cap, so nothing was self-limiting: 227 banked days were sitting in
-- November waiting to be drawn.
--
-- NO DISBURSED SALARY MOVES, and that is a measurement, not a hope. September
-- is the walk's first month, so every September opening is zero and all 331
-- disbursed September payslips are untouched by definition. The one disbursed
-- October payslip (Sardar Tariq, PKR 29,400) reads opening 0, earned 0,
-- taken 0, unpaid 9, closing 0. Section 4 asserts both rather than trusting
-- this paragraph — a note is a measurement of the moment it was written.
--
-- THE GATE APPLIES TO THE WHOLE WALK, from 1 September 2026, and needs no
-- effective-date fence precisely because September carried nothing. October
-- payroll, which is unrun (1 payslip of ~400), computes with no carry.
--
-- NO DATA CHANGE TURNS IT OFF. leave_carry_forward is already false on all 52
-- clients; the gate alone removes the carry. This migration writes no client
-- row and no employee row.
--
-- CARRY IS DATED. clients.leave_carry_start (0049, null on all 52) is now
-- load-bearing: switching a client on without naming a start month would
-- silently backdate a bank to September and re-grant everything this file
-- removes. carry_on_needs_a_start makes the half-set state impossible, and the
-- gate reads `period >= leave_carry_start`.
--
-- FORFEITS ON ARRIVAL (DECIDED 2026-11-04, Shayan, choosing between forfeit,
-- freeze and travels-with-him). A balance is ONE NUMBER and cannot be partly
-- carried, so the period carries only when EVERY client the guard stood on in
-- it carries. One of the 59 carrying guards has stood on more than one client's
-- contract since September, so this arm is live, not theoretical.
--
-- 0438's "DECIDED: no opening balances" IS REVERSED HERE, BY NAME. It was
-- right when the ledger opened at zero for everyone on one date; it is wrong
-- once a client can be switched on in, say, February, with guards who have
-- stood there for years. The reversal is recorded on the column and in
-- LeaveBalances.tsx, whose header and on-screen explainer both still said
-- "every balance opens at zero on 1 September 2026" and are corrected in the
-- same sitting. The pre-0438 pair employees.opening_leaves /
-- opening_leaves_month (0054/0055, null on all 704) is NOT reused — it carries
-- no who/when/why — and is marked superseded below rather than left to read as
-- a live feature.
--
-- leave_periods_all HAS FOUR AUTHORS (0438, 0540, 0558, 0564). Section 3 is
-- surgery against the live definition, every anchor asserted to appear exactly
-- once. It is never restated: no file holds its true text.
--
-- THE SCREEN'S OWN CARRY IS REMOVED IN THE SAME SITTING, and that is not
-- tidying. PayrollManagement.tsx re-derived a carried allowance from this very
-- flag (clientCarryEnabled / clientCarryStart / carriedAllowance, fed by a
-- 12-month attendance_leave_history fetch). It has been DEAD since 0438 —
-- line 952 prefers leave_period_summary whenever the guard has attendance in
-- the month, which for a guard is always — but dead code that reads a flag is
-- a trap, not a leftover: this file makes the flag MEAN something again, so the
-- first client switched on would have woken a second, contradictory carry for
-- everyone that screen has no ledger row for, which is office staff of that
-- client. The ledger answers; the screen reads.
--
-- DEFERRED: public.attendance_leave_history() now has NO CALLER IN src/. It is
-- still exercised by supabase/tests/attendance_status.sql (T24), so it is not
-- dropped here — dropping it is a prod write in its own right and wants its own
-- authorisation. Marked rather than left silent, because a function nothing
-- calls reads six months on as a feature somebody forgot to wire up.
--
-- NO NEW PERMISSION KEY, deliberately — a key absent from PERMISSION_GROUPS is
-- a gate nobody can reach (0361, 0384). An opening balance is a write to
-- employees from the Leave screen, so set_leave_opening() asks payroll.edit,
-- exactly as its sibling set_leave_quota_override() does. The carry switch is a
-- write to clients, so it asks clients.edit — the existing RLS (0310) and audit
-- trigger on that table already carry it, and the screen hides the control
-- without the key.

-- ---------------------------------------------------------------------------
-- 1. CARRY IS DATED. A client that carries must say from when.
-- ---------------------------------------------------------------------------
comment on column public.clients.leave_carry_forward is
  '0639: does this client carry unused leave past the period end? Chosen per client; false = use-it-or-lose-it within the period. Read by leave_periods_all() together with leave_carry_start; a guard forfeits his bank the period he stands on a client where this is false (DECIDED 2026-11-04). Written from the Leave screen under clients.edit.';
comment on column public.clients.leave_carry_start is
  '0639: the first period for which this client carries. REQUIRED when leave_carry_forward is true (carry_on_needs_a_start) so switching carry on cannot silently backdate a bank to September 2026. Periods before it do not carry even while the flag is true.';

-- All 52 rows are (false, null) today, so this validates without a rewrite.
alter table public.clients drop constraint if exists carry_on_needs_a_start;
alter table public.clients add constraint carry_on_needs_a_start check (
  leave_carry_forward is not true or leave_carry_start is not null
);

-- ---------------------------------------------------------------------------
-- 2. THE OPENING BALANCE. A named human decision, never a setting.
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists leave_opening_balance integer,
  add column if not exists leave_opening_month   date,
  add column if not exists leave_opening_reason  text,
  add column if not exists leave_opening_by      uuid,
  add column if not exists leave_opening_at      timestamptz;

-- EVERY TERM IS NULL-SAFE, for the reason 0438 records against
-- leave_quota_override_complete: a CHECK passes when it evaluates to NULL, not
-- only to true, so a null reason written as length(trim(reason)) > 0 made the
-- arm NULL and the row was ACCEPTED — an opening balance with no reason, the
-- one thing this constraint exists to refuse.
alter table public.employees drop constraint if exists leave_opening_complete;
alter table public.employees add constraint leave_opening_complete check (
  (leave_opening_balance is null and leave_opening_month is null
     and leave_opening_reason is null and leave_opening_by is null
     and leave_opening_at is null)
  or
  (leave_opening_balance is not null and leave_opening_balance between 0 and 15
     and leave_opening_month is not null
     and leave_opening_month = date_trunc('month', leave_opening_month)::date
     and leave_opening_reason is not null and length(trim(leave_opening_reason)) > 0
     and leave_opening_by is not null and leave_opening_at is not null)
);

comment on column public.employees.leave_opening_balance is
  '0639: this guard''s leave balance as at leave_opening_month, replacing the derived running balance for that one period, clamped to the 15-day cap. REVERSES 0438''s "DECIDED: no opening balances", which was right while the ledger opened at zero for everyone on one date and wrong once a client can be switched on later with guards who have stood there for years. Only effective where the client carries (leave_carry_forward and period >= leave_carry_start); set_leave_opening() refuses it otherwise rather than record a figure that would lapse in the same breath. NULL = no opening. Cannot exist without month/reason/by/at (leave_opening_complete).';
comment on column public.employees.leave_opening_month is
  '0639: the period leave_opening_balance opens. First of a month, never before 2026-09-01.';

-- The pre-0438 pair. Dead (null on all 704 employees), kept so no historical
-- row loses a column, and MARKED so it does not read six months from now as a
-- live feature somebody should wire up.
comment on column public.employees.opening_leaves is
  '0639 SUPERSEDED by leave_opening_balance. The pre-0438 accrual restart (0054): base_allowed + opening at the carry anchor. Null on every row and read by nothing since 0438 made the ledger derived. Carries no reason/by/at, which is why it was not reused. Do not write it.';
comment on column public.employees.opening_leaves_month is
  '0639 SUPERSEDED by leave_opening_month. See opening_leaves. Do not write it.';

-- The setter, so who/when/why are always stamped together. Single-row write
-- (where id = $1) behind require_perm, so a hidden row is a REFUSAL and not a
-- quietly smaller result — the set-operation hazard does not apply here.
create or replace function public.set_leave_opening(
  p_employee_id uuid, p_balance integer, p_month date, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v_carry boolean;  v_month date;
begin
  perform public.require_perm('payroll.edit');
  -- tenant guard [resolved]: owning company looked up from p_employee_id via public.employees (0639)
  if p_employee_id is not null then
    perform public.assert_same_company((select company_id from public.employees where id = p_employee_id));
  end if;

  if p_balance is null then
    -- Clearing leaves no decision to explain: the guard returns to the derived balance.
    update public.employees
       set leave_opening_balance = null, leave_opening_month = null,
           leave_opening_reason = null, leave_opening_by = null, leave_opening_at = null
     where id = p_employee_id;
  else
    if p_month is null then
      raise exception 'An opening balance needs the month it opens — without one there is nothing for it to replace.';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'An opening balance needs a reason — it is a decision recorded against a named guard, not a setting.';
    end if;
    v_month := date_trunc('month', p_month)::date;
    if v_month < date '2026-09-01' then
      raise exception 'The leave ledger begins 1 September 2026; an opening balance cannot name an earlier month.';
    end if;
    -- An opening on a client that does not carry would be banked and lapse in
    -- the same breath. Refuse rather than store a figure that does nothing: a
    -- setting with no effect is the failure mode this project exists to remove.
    select (cl.leave_carry_forward and cl.leave_carry_start is not null and v_month >= cl.leave_carry_start)
      into v_carry
      from public.employees e
      left join public.clients cl on cl.id = e.client_id
     where e.id = p_employee_id;
    if not coalesce(v_carry, false) then
      raise exception 'This guard''s client does not carry leave forward for %, so an opening balance would lapse the period it is set. Switch carry-forward on for the client, from that month or earlier, first.', to_char(v_month, 'Mon YYYY');
    end if;
    update public.employees
       set leave_opening_balance = p_balance, leave_opening_month = v_month,
           leave_opening_reason = trim(p_reason),
           leave_opening_by = auth.uid(), leave_opening_at = now()
     where id = p_employee_id;
  end if;
  if not found then raise exception 'Employee not found.'; end if;
end;
$fn$;
comment on function public.set_leave_opening(uuid, integer, date, text) is
  '0639: records a guard''s opening leave balance with reason/by/at stamped together, or clears it when p_balance is null. Asks payroll.edit, as set_leave_quota_override() does — same table, same screen, no new key to catalogue. Refuses a month before September 2026, a blank reason, and a client that does not carry for that month.';
revoke execute on function public.set_leave_opening(uuid, integer, date, text) from anon, public;
grant  execute on function public.set_leave_opening(uuid, integer, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3a. THE BEFORE PICTURE, captured before the surgery so section 4 can compare
-- against a measurement rather than against a number written into this file.
-- ---------------------------------------------------------------------------
-- Per ROW, so every assertion below is exact rather than aggregate, and the
-- disbursed payslips can be checked one by one.
create temporary table _before_0639 (
  company_id uuid, employee_id uuid, period_start date,
  leave_days int, earned int, lost int, opening numeric,
  taken int, unpaid int, closing numeric
);
-- Deliberately NOT `on commit drop`: apply_migration runs this file in one
-- transaction, but psql and the SQL editor commit each statement, and the
-- before picture has to outlive section 3b either way. Dropped explicitly at
-- the foot of the file.


do $capture$
declare c record;
begin
  for c in select id from public.companies loop
    insert into _before_0639
    select c.id, l.employee_id, l.period_start, l.leave_days, l.earned, l.lost,
           l.opening, l.taken, l.unpaid, l.closing
      from public.leave_periods_all(c.id, date '2026-11-30') l;
  end loop;
  if not exists (select 1 from _before_0639) then
    raise exception '0639 REFUSED: the before picture is empty — leave_periods_all returned nothing, so nothing below can be verified.';
  end if;
end
$capture$;

-- ---------------------------------------------------------------------------
-- 3b. THE GATE. Surgery against the live definition of leave_periods_all,
-- which has FOUR authors (0438, 0540, 0558, 0564) and therefore no canonical
-- file. Every anchor is asserted to appear EXACTLY ONCE; a missing or doubled
-- anchor refuses rather than widens.
-- ---------------------------------------------------------------------------
do $surgery$
declare
  v_def  text;
  v_new  text;
  v_a    text;
  v_hits int;
  v_anchors text[] := array[
    '      wq as (select employee_id, avg(q) as q from pq group by employee_id),',
    '             sq.nseg, sq.earned_seg,',
    '        left join sq on sq.employee_id = ap.employee_id',
    '      v_open := coalesce((v_bal ->> r.employee_id::text)::numeric, 0);',
    '      v_close  := v_open + v_earn - v_take;'
  ];
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'leave_periods_all';
  if v_def is null then
    raise exception '0639 REFUSED: public.leave_periods_all() does not exist.';
  end if;
  if position('leave_carry_forward' in v_def) > 0 then
    raise exception '0639 REFUSED: leave_periods_all() already names leave_carry_forward — the gate is in, do not apply this twice.';
  end if;

  foreach v_a in array v_anchors loop
    v_hits := (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a);
    if v_hits <> 1 then
      raise exception '0639 REFUSED: anchor appears % times, expected exactly 1: %', v_hits, v_a;
    end if;
  end loop;

  v_new := v_def;

  -- (i) Which clients did he stand on this period, and do they all carry?
  v_new := replace(v_new, v_anchors[1],
    v_anchors[1] || E'\n' ||
    E'      -- 0639: CARRY IS THE CLIENT RULE, dated by clients.leave_carry_start.\n' ||
    E'      -- A balance is ONE NUMBER and cannot be partly carried, so a period\n' ||
    E'      -- carries only when EVERY client he stood on in it carries for that\n' ||
    E'      -- period. A guard therefore FORFEITS his bank on arrival at a client\n' ||
    E'      -- that does not (DECIDED 2026-11-04, Shayan). An unknown client is\n' ||
    E'      -- not a carrying one: the default is false, never null.\n' ||
    E'      cf as (\n' ||
    E'        select pq.employee_id,\n' ||
    E'               bool_and(coalesce(cl.leave_carry_forward, false)\n' ||
    E'                        and cl.leave_carry_start is not null\n' ||
    E'                        and v_ms >= cl.leave_carry_start) as carry_ok\n' ||
    E'          from pq\n' ||
    E'          left join public.contracts k2 on k2.id = pq.kid\n' ||
    E'          left join public.clients   cl on cl.id = k2.client_id\n' ||
    E'         group by pq.employee_id\n' ||
    E'      ),');

  -- (ii) Carry verdict and the named opening onto the driving row. No present
  -- days means no stretch to read, so his own client decides.
  v_new := replace(v_new, v_anchors[2],
    v_anchors[2] || E'\n' ||
    E'             coalesce(cf.carry_ok,\n' ||
    E'                      (select cl3.leave_carry_forward\n' ||
    E'                                and cl3.leave_carry_start is not null\n' ||
    E'                                and v_ms >= cl3.leave_carry_start\n' ||
    E'                         from public.clients cl3 where cl3.id = e.client_id),\n' ||
    E'                      false) as carry_ok,\n' ||
    E'             e.leave_opening_balance, e.leave_opening_month,');

  v_new := replace(v_new, v_anchors[3],
    v_anchors[3] || E'\n' ||
    E'        left join cf on cf.employee_id = ap.employee_id');

  -- (iii) The opening. No carry means the bank did not survive the boundary.
  v_new := replace(v_new, v_anchors[4],
    E'      -- 0639: no carry, no opening. What was earned last period and not\n' ||
    E'      -- taken has lapsed; it is not banked here.\n' ||
    E'      v_open := case when r.carry_ok\n' ||
    E'                     then coalesce((v_bal ->> r.employee_id::text)::numeric, 0)\n' ||
    E'                     else 0 end;\n' ||
    E'      -- A NAMED OPENING BALANCE replaces the derived balance for the one\n' ||
    E'      -- period it names, under the same 15-day cap. set_leave_opening()\n' ||
    E'      -- refuses one on a non-carrying client, and this arm agrees with it\n' ||
    E'      -- rather than trusting it: a figure that would lapse is not applied.\n' ||
    E'      if r.carry_ok and r.leave_opening_balance is not null\n' ||
    E'         and r.leave_opening_month = v_ms then\n' ||
    E'        v_open := least(r.leave_opening_balance::numeric, 15);\n' ||
    E'      end if;');

  -- (iv) The closing. Nothing survives a period the client does not carry, so
  -- the row says zero instead of banking what the client rule never granted.
  -- earned minus taken is what lapsed, and both are already on the row.
  v_new := replace(v_new, v_anchors[5],
    E'      v_close  := case when r.carry_ok then v_open + v_earn - v_take else 0 end;');

  if v_new = v_def then
    raise exception '0639 REFUSED: surgery changed nothing.';
  end if;
  execute v_new;
end
$surgery$;

comment on function public.leave_periods_all(uuid, date) is
  '0438/0540/0558/0564/0639: the leave ledger for every guard, derived from attendance from 1 Sep 2026 (the gate is INSIDE this function): tier, quota, earned, lost at the cap, taken by leave marks, unpaid, closing. 0639: carry across the period boundary happens ONLY where the guard stood entirely on clients with leave_carry_forward and period >= leave_carry_start — otherwise the period opens AND closes at zero and unused earned leave lapses; a named employees.leave_opening_balance replaces the derived opening for the one period it names. DEFERRED: walks calendar months until contract_periods(...,''payroll'') is consumed.';

-- ---------------------------------------------------------------------------
-- 4. VERIFICATION. Each assertion names the failure it can distinguish. A
-- control that reports its own input is not a control, so nothing here counts
-- rows to prove a row was added.
-- ---------------------------------------------------------------------------
do $verify$
declare
  c_expected constant int := 7;
  v_checked  int := 0;
  v_n        int;
  v_co       uuid;
  v_cid      uuid;
  v_probe    int := -1;
  v_guards   int;
begin
  -- (1) THE GATE FIRED. No client carries, so nothing may open above zero.
  --     Distinguishes: the gate was not reached at all.
  select count(*) into v_n from public.companies c,
       lateral public.leave_periods_all(c.id, date '2026-11-30') l
   where l.opening > 0;
  if v_n <> 0 then
    raise exception '0639 FAILED (1): % period rows still open above zero while no client carries.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (2) OCTOBER IS OFF BY NAME, because that is what was asked for. Carried
  --     138 days into October before this file.
  select count(*) into v_n from public.companies c,
       lateral public.leave_periods_all(c.id, date '2026-11-30') l
   where l.period_start = date '2026-10-01' and l.opening > 0;
  if v_n <> 0 then
    raise exception '0639 FAILED (2): % guards still carry into October payroll.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (3) EARNING IS UNTOUCHED. The gate removes the carry, not the accrual.
  --     earned + lost is what the period WOULD earn before the cap, and the
  --     cap can only bite through the opening — so with the opening gone,
  --     earned must equal the old earned plus whatever the cap took.
  --     Distinguishes: the gate was written as a kill switch on leave itself.
  select count(*) into v_n
    from _before_0639 b
    join public.companies c on c.id = b.company_id
    join public.leave_periods_all(c.id, date '2026-11-30') a
      on a.employee_id = b.employee_id and a.period_start = b.period_start
   where a.earned <> b.earned + b.lost;
  if v_n <> 0 then
    raise exception '0639 FAILED (3): % rows changed what they EARN; the gate must remove carry only.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (4) THE CONSUMPTION IDENTITY still holds: every leave mark is either paid
  --     from the balance or unpaid, and never both or neither.
  select count(*) into v_n from public.companies c,
       lateral public.leave_periods_all(c.id, date '2026-11-30') l
   where l.taken + l.unpaid <> l.leave_days;
  if v_n <> 0 then
    raise exception '0639 FAILED (4): % rows where taken + unpaid <> leave marks.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (5) REMOVING CARRY CAN ONLY PAY FEWER LEAVE DAYS, never more. A row where
  --     more is now paid from the balance means the arithmetic inverted.
  select count(*) into v_n
    from _before_0639 b
    join public.companies c on c.id = b.company_id
    join public.leave_periods_all(c.id, date '2026-11-30') a
      on a.employee_id = b.employee_id and a.period_start = b.period_start
   where a.taken > b.taken;
  if v_n <> 0 then
    raise exception '0639 FAILED (5): % rows now pay MORE leave from the balance than before.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (6) SEPTEMBER DOES NOT MOVE. It is the walk first month, so it carried
  --     nothing and 331 disbursed payslips hang off it. `closing` is excluded
  --     deliberately: with carry off a September bank no longer survives the
  --     boundary and must read zero. Nothing a payslip was priced from — the
  --     opening, the earning, what was paid and what was unpaid — may differ.
  select count(*) into v_n
    from _before_0639 b
    join public.companies c on c.id = b.company_id
    join public.leave_periods_all(c.id, date '2026-11-30') a
      on a.employee_id = b.employee_id and a.period_start = b.period_start
   where b.period_start = date '2026-09-01'
     and (a.opening <> b.opening or a.earned <> b.earned
          or a.taken <> b.taken or a.unpaid <> b.unpaid);
  if v_n <> 0 then
    raise exception '0639 FAILED (6): % September rows moved; disbursed September payslips were priced off them.', v_n;
  end if;
  v_checked := v_checked + 1;

  -- (7) NO DISBURSED PAYSLIP MOVES, in any period. Asserted one payslip at a
  --     time rather than inferred from (6), because the next disbursement will
  --     not be in September and this assertion should still mean something.
  select count(*) into v_n
    from public.payslips p
    join _before_0639 b on b.employee_id = p.employee_id and b.period_start = p.period_month
    join public.companies c on c.id = b.company_id
    join public.leave_periods_all(c.id, date '2026-11-30') a
      on a.employee_id = b.employee_id and a.period_start = b.period_start
   where p.disbursed
     and (a.opening <> b.opening or a.earned <> b.earned
          or a.taken <> b.taken or a.unpaid <> b.unpaid);
  if v_n <> 0 then
    raise exception '0639 FAILED (7): % disbursed payslips sit on a leave row that moved.', v_n;
  end if;
  v_checked := v_checked + 1;

  if v_checked <> c_expected then
    raise exception '0639 CANARY FAILED: % of % assertions ran.', v_checked, c_expected;
  end if;

  -- ---------------------------------------------------------------------
  -- THE POSITIVE DIRECTION. Everything above is satisfied by a gate welded
  -- shut, which is the one failure none of it can see. So switch a client on
  -- inside a subtransaction, read the ledger, and roll that back: the write
  -- never commits, and plpgsql variables survive the rollback so the reading
  -- does. Only a client whose guards demonstrably accrued is any use as a
  -- probe — on one whose guards earn nothing, carry returning looks like
  -- carry staying off.
  -- ---------------------------------------------------------------------
  select b.company_id, e.client_id, count(*) into v_co, v_cid, v_guards
    from _before_0639 b
    join public.employees e on e.id = b.employee_id
   where b.opening > 0 and e.client_id is not null
   group by b.company_id, e.client_id
   order by count(*) desc limit 1;

  if v_cid is null then
    raise notice '0639: no guard carried anything before this change, so the ON direction has nothing to probe here. supabase/tests/leave_carry_gate.sql covers it.';
  else
    begin
      update public.clients
         set leave_carry_forward = true, leave_carry_start = date '2026-09-01'
       where id = v_cid;
      select count(*) into v_probe
        from public.leave_periods_all(v_co, date '2026-11-30') l
        join public.employees e on e.id = l.employee_id
       where e.client_id = v_cid and l.opening > 0;
      raise exception 'PROBE_0639_ROLLBACK';
    exception when others then
      if sqlerrm <> 'PROBE_0639_ROLLBACK' then raise; end if;
    end;
    if v_probe <= 0 then
      raise exception '0639 FAILED (probe): switching a client on brought no carry back (% guards were carrying before) — the gate is welded shut, not a gate.', v_guards;
    end if;
    select count(*) into v_n from public.clients where leave_carry_forward;
    raise notice '0639: gate verified both ways — % of % clients carry, and % of % previously-carrying guards carry again when one client is switched on (rolled back).',
      v_n, (select count(*) from public.clients), v_probe, v_guards;
  end if;

  raise notice '0639: %/% assertions passed. Carry is now the client decision; no client carries; no disbursed payslip moved.', v_checked, c_expected;
end
$verify$;

drop table if exists _before_0639;
