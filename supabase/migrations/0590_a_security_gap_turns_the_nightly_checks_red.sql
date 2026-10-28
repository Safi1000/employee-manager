-- 0590 — a security gap turns the nightly checks red
--
-- Phase 0, Migration D. Shayan, 28 Oct 2026: "lets wrap it up in one go …
-- just wind it up". 0584–0589 closed what was found; this makes the finding
-- automatic, so nothing they closed can reopen without the ledger checks
-- saying so the next morning.
--
-- public.security_gaps() — company-independent, one row per gap:
--   function   a SECURITY DEFINER function a login can call, that reads or
--              writes a money table, checks no permission (require_perm /
--              has_perm / has_permission) and has no row in api_function_gates.
--   table      a table with a money-shaped column (amount, balance, salary,
--              rate, cost, price, share, wage, net_, gross, fee, debit, credit,
--              bonus, deduction) that is neither read-gated (a restrictive
--              perm_read or ssa_only, or row security with no permissive
--              policy at all) nor labelled DECIDED or DEFERRED on the object.
--   gate       an api_function_gates row naming a function that does not
--              exist, or a key the grant screen cannot offer.
--   api        PostgREST's db_pre_request is not api_request_gate.
--
-- ledger_checks() gains `no_security_gap` (count of rows, expected 0), and its
-- canary expected_check_count goes 47 → 48 — by surgery against the live
-- definition (ledger_checks has many authors), each anchor asserted once.
--
-- What it reports on arrival is resolved here, not left red:
--   * assert_cheque_capacity and next_invoice_number — missed by 0584; called
--     only by a definer trigger and run_auto_invoices. Revoked.
--   * Eighteen money-shaped tables that are open on purpose get the word on
--     the object, with the reason (CLAUDE.md: an unmarked flag reads as a
--     decision nobody made).
--   * contracts / contract_lines / contract_addendums — DEFERRED: billing
--     rates are readable by whoever can read a contract. Hiding them needs
--     column privileges plus rate functions across ~25 screen reads and
--     contract_periods(); put to Shayan 28 Oct with a recommendation to
--     decide them open. The change, if decided the other way, is that.
--
-- Asserted: security_gaps() returns no row once 0587–0589 are in; for GGS the
-- new check passes AND the canary's own `passed` is true with expected 48 —
-- the canary's verdict, not the row count, which moves with any added check.

-- ── 1. the last two money functions 0584 missed ─────────────────────────────
do $rv$
declare v_bad text;
begin
  revoke execute on function public.assert_cheque_capacity(uuid) from public, anon, authenticated;
  revoke execute on function public.next_invoice_number(uuid, date) from public, anon, authenticated;
  grant execute on function public.assert_cheque_capacity(uuid) to service_role;
  grant execute on function public.next_invoice_number(uuid, date) to service_role;
  select string_agg(distinct q.proname, ', ') into v_bad
    from pg_proc q where q.pronamespace = 'public'::regnamespace and not q.prosecdef
     and q.prosrc ~* '\m(assert_cheque_capacity|next_invoice_number)\M' and q.proname not in ('branch_guard_covered');
  if v_bad is not null then raise exception '0590 REFUSED: invoker functions call a revoked function: %', v_bad; end if;
end $rv$;

-- ── 2. open on purpose, and said so ─────────────────────────────────────────
comment on table public.employees is 'DECIDED 0590: read by HR (salary is HR''s to set); a linked login is held to his own row by 0424''s self_scope.';
comment on table public.employee_salary_history is 'DECIDED 0590: read as employees are — HR sets salaries.';
comment on table public.clearance_certificates is 'DECIDED 0590: read as employees are — the dues a guard is cleared with.';
comment on table public.clients is 'DECIDED 0590: read company-wide — the client master every operational screen picks from.';
comment on table public.companies is 'DECIDED 0590: a login reads its own company row (settings, branding, subscription).';
comment on table public.cash_locations is 'DECIDED 0590: read company-wide — the custodian picker on every screen that pays in cash. opening_balance is readable; balances are folded only with banking access (0586) or by my_cash_held() (0589).';
comment on table public.approval_configs is 'DECIDED 0590: read company-wide — who approves what, shown to those who request.';
comment on table public.approval_requests is 'DECIDED 0590: read company-wide — a request is seen by its requester and its approvers.';
comment on table public.inventory_item_types is 'DECIDED 0590: read company-wide — the kit catalogue the store, issuance and clearance screens pick from.';
comment on table public.inventory_stock is 'DECIDED 0590: read company-wide — what the store holds, for issuance.';
comment on table public.kit_events is 'DECIDED 0590: read company-wide — kit issued, returned and handed over.';
comment on table public.vehicle_logs is 'DECIDED 0590: read company-wide — fleet logs on the assets register.';
comment on table public.finance_settings is 'DECIDED 0590: read company-wide — reminder steps and danger thresholds; the danger_level and due_invoice_reminders views and write_off_receivable read it as the user.';
comment on table public.ai_usage is 'DECIDED 0590: a company''s members read its AI usage meter.';
comment on table public.signup_intents is 'DECIDED 0590: row security on, no permissive policy — no login reads it; the signup Edge Function uses the service role.';
comment on table public.contracts is 'DEFERRED 0590: billing rates (rate_per_guard_per_month, guard_rates) are readable by whoever can read a contract. The change, if decided: column privileges plus rate functions for billing screens; ~25 screen reads and contract_periods() read whole rows.';
comment on table public.contract_lines is 'DEFERRED 0590: unit_rate, billing_rate, client_ot_rate, cost_components readable with the line — see contracts.';
comment on table public.contract_addendums is 'DEFERRED 0590: new_rate, unit_rate readable with the addendum — see contracts.';

-- ── 3. the finding, as a function ───────────────────────────────────────────
create or replace function public.security_gaps()
returns table (kind text, object_name text, detail text)
language sql
stable
security definer
set search_path = public
as $$
  -- 0590. Company-independent. Each row is a gap; an empty result is the pass.
  with money_tables as (
    select '\m(journal_lines|journal_entries|bank_transactions|bank_accounts|payslips|payroll_runs|partner_account_entries|'
        || 'profit_allocation_runs|region_declared_profit|invoices|invoice_payments|cash_locations|advances|expenses|vendor_payments|'
        || 'cheques|cash_deposits|custody_transfers|investor_ledger_entries|fuel_card_loads|security_deposits|guard_bonuses)\M' as re
  )
  select 'function', p.oid::regprocedure::text,
         'a login can call it; it touches money; it checks no permission and has no api_function_gates row'
    from pg_proc p, money_tables m
   where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'execute')
     and p.prosrc !~* '(require_perm|has_perm|has_permission)\s*\('
     and not exists (select 1 from public.api_function_gates g where g.function_name = p.proname)
     and p.prosrc ~* m.re
  union all
  select 'table', c.relname::text, 'money-shaped, not read-gated, and not marked DECIDED or DEFERRED'
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and exists (select 1 from information_schema.columns k
                  where k.table_schema = 'public' and k.table_name = c.relname
                    and k.data_type in ('numeric','integer','bigint','double precision','real')
                    and k.column_name ~* '(amount|balance|salary|_rate$|^rate|cost|price|share|wage|^net_|gross|fee|debit|credit|bonus|deduction)')
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                      and p.permissive = 'RESTRICTIVE' and p.policyname in ('perm_read','ssa_only'))
     and not (c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.permissive = 'PERMISSIVE'))
     and coalesce(obj_description(c.oid, 'pg_class'), '') !~ '^(DECIDED|DEFERRED)'
  union all
  select 'gate', g.function_name, 'names a function that does not exist'
    from public.api_function_gates g
   where not exists (select 1 from pg_proc p where p.proname = g.function_name and p.pronamespace = 'public'::regnamespace)
  union all
  select 'gate', g.function_name, 'names a key the grant screen cannot offer: ' || k
    from public.api_function_gates g, unnest(g.any_of) k
   where not exists (select 1 from public.permission_keys pk where pk.key = k)
  union all
  select 'api', 'authenticator', 'PostgREST db_pre_request is not public.api_request_gate'
   where not exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
                      where r.rolname = 'authenticator' and 'pgrst.db_pre_request=public.api_request_gate' = any(s.setconfig));
$$;
comment on function public.security_gaps() is
  'TENANT GUARD EXEMPT: takes no argument and reads only the catalogue. 0590: every security gap of the kinds 0584–0589 closed — '
  'evaluated nightly by ledger_checks() as no_security_gap.';
revoke all on function public.security_gaps() from public, anon;
grant execute on function public.security_gaps() to authenticated;
insert into public.api_function_gates (function_name, any_of, reason)
values ('security_gaps', '{reports.view,accountant.view}', 'Read by ledger_checks (Overview tab, Accountant) (0590)')
on conflict (function_name) do nothing;

-- ── 4. into the nightly checks (surgery; ledger_checks has many authors) ────
do $surgery$
declare
  v_def text := pg_get_functiondef('public.ledger_checks(uuid)'::regprocedure);
  a_check constant text := E'      from public.branch_guard_gaps() b where b.shape = ''writes''\n  )\n  select * from real_checks';
  a_canary constant text := E'    from (select 47::numeric n) e (n);';
  v_n int;
begin
  if position('no_security_gap' in v_def) > 0 then return; end if;   -- replay
  v_n := (length(v_def) - length(replace(v_def, a_check, ''))) / length(a_check);
  if v_n <> 1 then raise exception '0590 REFUSED: the last-check anchor appears % times in ledger_checks.', v_n; end if;
  v_n := (length(v_def) - length(replace(v_def, a_canary, ''))) / length(a_canary);
  if v_n <> 1 then raise exception '0590 REFUSED: the canary anchor appears % times in ledger_checks.', v_n; end if;
  v_def := replace(v_def, a_check,
       E'      from public.branch_guard_gaps() b where b.shape = ''writes''\n'
    || E'    union all\n'
    || E'    -- 0590. Is any money function callable without a permission or a gate,\n'
    || E'    -- any money-shaped table neither gated nor marked, any gate broken, or\n'
    || E'    -- the API gate switched off? Company-independent: it reads the catalogue.\n'
    || E'    select ''no_security_gap''::text,\n'
    || E'           0::numeric, count(*)::numeric, count(*)::numeric, count(*) = 0\n'
    || E'      from public.security_gaps()\n'
    || E'  )\n  select * from real_checks');
  v_def := replace(v_def, a_canary, E'    from (select 48::numeric n) e (n);');
  execute v_def;
end $surgery$;

-- ── 5. proof ────────────────────────────────────────────────────────────────
do $test$
declare
  v_co constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_gaps text; v_canary record; v_check record;
begin
  select string_agg(kind || ' ' || object_name || ' — ' || detail, '; ') into v_gaps from public.security_gaps();
  if v_gaps is not null then raise exception '0590 REFUSED: security_gaps() reports: %', v_gaps; end if;

  select * into v_check from public.ledger_checks(v_co) where check_name = 'no_security_gap';
  if v_check.check_name is null or not v_check.passed then raise exception '0590 REFUSED: no_security_gap is missing or red.'; end if;
  select * into v_canary from public.ledger_checks(v_co) where check_name = 'checks_evaluated';
  if v_canary.expected <> 48 or not v_canary.passed then
    raise exception '0590 REFUSED: the canary reads expected %, actual %, passed % — not 48 and true.', v_canary.expected, v_canary.actual, v_canary.passed;
  end if;
end $test$;
