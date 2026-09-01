-- 0242 — Every SECURITY DEFINER function that takes a tenant-scoped id now
-- proves the caller owns it.
--
-- SECURITY FIX. DEV ONLY. Production is closed to changes without a named
-- approval; prod gets this as its own named change once dev has proved it.
--
-- WHAT WAS OPEN
--
-- SECURITY DEFINER means "run as the owner", which means NO CALLER RLS. That
-- is the entire point of the mode, and it is why every one of these functions
-- has to check the tenant itself. Almost none of them did:
--
--   SECURITY DEFINER functions in public taking a uuid ............ 140
--   ...that compare it against current_company_id()/is_ssa_unscoped()   2
--   ...that check some other authorisation (visibility, permission)    4
--   ...with NO authorisation check of any kind ................... 134
--
-- 77 of the 138 unguarded ones write.
--
-- THE EARLIER COUNT OF 46 WAS WRONG, IN BOTH DIRECTIONS
--
-- The first pass filtered on "the body never mentions company_id" and read
-- that as "not tenant-aware". It means nothing of the kind. post_journal
-- mentions company_id eleven times and never once compares it to the caller's.
-- That filter hid the worse half of the problem and included five functions
-- that take no tenant id at all.
--
-- TWO PATTERNS, AND THEY ARE NOT THE SAME PATTERN
--
-- They read almost identically at the call site and they mean different
-- things. A reviewer who conflates them will eventually resolve a parameter
-- against itself and prove nothing, so each generated call site is labelled.
--
--   [resolved] — the function takes an OBJECT id (p_employee_id, p_run_id).
--                The object's owning company is looked up, then compared.
--                79 functions.
--
--   [claimed]  — the function takes p_company_id DIRECTLY. The parameter IS
--                the caller's claim about which tenant to act on, so it is
--                compared as given. Resolving it would be circular.
--                59 functions.
--
-- The [claimed] half is the more dangerous one and it is the half that was
-- missed. No id-guessing is needed: the caller simply names the company.
-- post_journal, seed_chart_of_accounts, next_invoice_number, fund_region,
-- add_subscription_payment, run_ho_cost_allocation — all took the tenant as an
-- argument and did as they were told.
--
-- WHY THE GUARD IS GENERATED RATHER THAN HAND-WRITTEN
--
-- 133 functions get the same three lines. Hand-editing 133 bodies means 133
-- chances to skip one, and the one that gets skipped is invisible. A generator
-- driven off the catalogue cannot miss a function that matches the predicate,
-- and the check in 0243 then fails if a later migration adds one. The
-- resolver map below IS hand-written and reviewed, because deciding which
-- table an id parameter refers to is the part that needs a human.
--
-- The generated bodies are not in this file; the catalogue holds them. The
-- verification at the foot asserts the property directly — every qualifying
-- function calls assert_same_company — rather than trusting that the
-- generation ran.

-- ---------------------------------------------------------------------------
-- PART 1. The helper.
-- ---------------------------------------------------------------------------

create or replace function public.assert_same_company(p_company_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  -- Trusted backend roles carry no tenant identity at all: service_role runs
  -- the Edge Functions (signup-complete, stripe-webhook, billing-checkout) and
  -- the compliance cron; postgres/supabase_admin run migrations and psql.
  -- current_company_id() reads profiles by auth.uid(), and none of them have a
  -- profile, so it returns NULL for all of them.
  --
  -- Enforcing here would therefore raise on every signup, every billing
  -- webhook, every cron run and every migration. That is not a stricter guard,
  -- it is a broken one. These roles already bypass RLS everywhere in this
  -- schema and their credentials never reach a browser.
  --
  -- anon is listed as enforced rather than exempt even though 0241 revoked its
  -- EXECUTE on everything in public: defence in depth costs nothing here, and
  -- a future GRANT that re-opens one function should not also un-guard it.
  if current_user not in ('authenticated', 'anon') then
    return;
  end if;

  -- NULL and mismatch raise IDENTICALLY, and that is deliberate.
  --
  -- If "no such row" and "not your row" gave different answers, every guarded
  -- function would become an existence oracle: a caller could walk a uuid space
  -- and learn which ids are real without ever being allowed to read one. The
  -- message says nothing and the errcode says nothing. It is unhelpful ON
  -- PURPOSE. Do not split these branches to improve the error text.
  if p_company_id is null
     or (p_company_id is distinct from public.current_company_id()
         and not public.is_ssa_unscoped()) then
    raise exception 'Row not found' using errcode = '42501';
  end if;
end
$fn$;

comment on function public.assert_same_company(uuid) is
  'Tenant guard for SECURITY DEFINER functions, which get no caller RLS. Raises 42501 identically for a NULL company and for another company''s, so it cannot be used as an existence oracle. Exempts service_role/postgres, which carry no tenant identity and would otherwise break signup, billing, cron and migrations. See 0242.';

revoke execute on function public.assert_same_company(uuid) from anon, public;
grant  execute on function public.assert_same_company(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- PART 2. The resolver map. HAND-WRITTEN. This is the reviewed part.
--
-- Which table does each id parameter name refer to? A generator cannot know
-- this and guessing it from the name is how you end up resolving p_client_id
-- against employees. Every row here was checked against the function bodies
-- that use the parameter, and PART 4 asserts each table exists and carries a
-- company_id column before anything is generated.
-- ---------------------------------------------------------------------------

create temp table _tg_map (param text primary key, tbl text not null) on commit drop;

insert into _tg_map (param, tbl) values
  ('p_employee_id',     'employees'),
  ('p_employee',        'employees'),
  ('p_guard',           'employees'),          -- attendance/deployment naming
  ('p_guard_id',        'employees'),
  ('p_client_id',       'clients'),
  ('p_client',          'clients'),
  ('p_run_id',          'payroll_runs'),
  ('p_id',              'payslips'),           -- payslip_client_split, post_payslip_*
  ('p_payslip_id',      'payslips'),
  ('p_invoice_id',      'invoices'),
  ('p_contract_id',     'contracts'),
  ('p_bank_account_id', 'bank_accounts'),
  ('p_cheque',          'cheques'),
  ('p_batch_id',        'opening_balance_batches'),
  ('p_partner_id',      'partners'),
  ('p_alert_id',        'alerts'),
  ('p_allocation_id',   'bonus_pool_allocations'),
  ('p_pool_id',         'bonus_pools'),
  ('p_appraisal_id',    'appraisals'),
  ('p_asset_id',        'fixed_assets'),
  ('p_assignee_id',     'profiles'),           -- tasks are assigned to users
  ('p_mobilisation_id', 'contract_mobilisations'),
  ('p_request_id',      'approval_requests'),
  ('p_post_id',         'posts'),
  ('p_site',            'sites');

-- ---------------------------------------------------------------------------
-- PART 3. Exemptions, each with a RECORDED VERDICT.
--
-- An unexplained exception becomes a copied exception. Every name here states
-- why it is exempt in the code, not in a commit message.
-- ---------------------------------------------------------------------------

create temp table _tg_exempt (fn text primary key, verdict text not null) on commit drop;

insert into _tg_exempt (fn, verdict) values
  ('user_can_see_employee',
   'AUTHORISATION HELPER. Answering "may I see this employee?" about an id the '
   'caller does not own is precisely its job — it exists to return false for '
   'exactly that case. Guarding it would make it raise where it should answer, '
   'and it is used in four RLS policies, so raising would break reads rather '
   'than deny them. The omission is deliberate.'),

  ('can_see_region',
   'AUTHORISATION HELPER. Same reasoning as user_can_see_employee: it answers a '
   'yes/no question about an arbitrary region id, and false IS the refusal. '
   'The omission is deliberate.'),

  ('employee_in_branch',
   'AUTHORISATION HELPER, and used in an RLS policy. Answering about an '
   'arbitrary employee/branch pair is its purpose. The omission is deliberate.'),

  ('is_action_approved',
   'AUTHORISATION HELPER. Takes a POLYMORPHIC (p_ref_table, p_ref_id) pair, so '
   'there is no single table to resolve against and the resolved pattern cannot '
   'be applied mechanically. Stated honestly: this does leak whether an action '
   'was approved for another company''s ref_id — a boolean, no amounts, no '
   'names. Logged as a residual in PRE_GO_LIVE.md rather than silently '
   'accepted; closing it needs a per-ref_table resolver, which is its own '
   'change.'),

  ('employee_company_id',
   'THE RESOLVER ITSELF. The [resolved] pattern is built on looking an object''s '
   'company up; guarding the lookup with a guard that needs the lookup is '
   'circular and would recurse. It returns a company_id for an employee id and '
   'nothing else — no names, no pay, no dates. It is also used in an RLS '
   'policy, where raising would break reads. The omission is deliberate and '
   'structural.'),

  ('has_perm',
   'AUTHORISATION HELPER, and not in the 138 at all — it takes text, not a '
   'uuid. Recorded here because it was on the earlier list of 46 and a reader '
   'who finds it missing should learn why rather than re-derive it.'),

  ('has_permission',
   'AUTHORISATION HELPER, takes text. Same note as has_perm. It answers about '
   'the CALLER''s own permissions via auth.uid() and takes no tenant id, so '
   'there is nothing to guard.');

-- ---------------------------------------------------------------------------
-- PART 4. Preconditions. Checked before a single function is rewritten.
-- ---------------------------------------------------------------------------

do $pre$
declare
  v_bad text;
begin
  -- 4a. Every mapped table exists and carries company_id.
  select string_agg(m.param || '->' || m.tbl, ', ')
    into v_bad
    from _tg_map m
   where not exists (
     select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = m.tbl
        and c.column_name = 'company_id');
  if v_bad is not null then
    raise exception '0242 resolver map is wrong — no public.<table>.company_id for: %', v_bad;
  end if;

  -- 4b. Injection safety. The plpgsql rewrite inserts the guard after the
  -- function's first `begin` token. If that token were inside a string literal
  -- in a declare-section default, the injection would corrupt the literal and
  -- still compile. Prove it is not, rather than assume it: an odd number of
  -- quote characters before the match means we are inside one.
  select string_agg(x.proname, ', ')
    into v_bad
    from (
      select p.proname, p.prosrc, regexp_instr(p.prosrc, '\mbegin\M', 1, 1, 0, 'i') b
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and l.lanname = 'plpgsql'
         and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
    ) x
   where x.b = 0
      or (length(left(x.prosrc, x.b - 1))
          - length(replace(left(x.prosrc, x.b - 1), '''', ''))) % 2 = 1;
  if v_bad is not null then
    raise exception '0242 cannot safely inject into: % — first `begin` is missing or inside a string literal', v_bad;
  end if;

  -- 4c. The body delimiter the rewrite splits on must not occur in any body.
  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and p.prosrc like '%$function$%';
  if v_bad is not null then
    raise exception '0242 cannot rewrite % — body contains the $function$ delimiter', v_bad;
  end if;

  -- 4d. Every function that will be rewritten under the [resolved] pattern has
  -- its first uuid parameter in the map. An unmapped parameter must stop the
  -- migration, never be skipped quietly — a skipped function is an unguarded
  -- function that nothing reports.
  select string_agg(x.proname || '(' || x.param || ')', ', ')
    into v_bad
    from (
      select p.proname, (regexp_match(pg_get_function_identity_arguments(p.oid), '(\w+)\s+uuid'))[1] param
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
         and pg_get_function_identity_arguments(p.oid) not ilike 'p_company%'
         and p.prosrc not ilike '%current_company_id%'
         and p.prosrc not ilike '%is_ssa_unscoped%'
       and p.prosrc not ilike '%assert_same_company%'
         and p.proname not in (select fn from _tg_exempt)
    ) x
   where x.param is null or x.param not in (select param from _tg_map);
  if v_bad is not null then
    raise exception '0242 resolver map has no entry for: %', v_bad;
  end if;
end
$pre$;

-- ---------------------------------------------------------------------------
-- PART 5. Generation.
--
-- plpgsql bodies are injected in place: the guard goes in immediately after
-- the opening `begin`, so it runs BEFORE any statement that could leak. That
-- ordering matters beyond the obvious — assert_cheque_capacity and
-- post_opening_balances quote money figures in their exception messages, so a
-- guard placed after their first select would refuse the call and still have
-- disclosed the number.
--
-- `language sql` bodies cannot raise, so they are converted to plpgsql. Three
-- shapes, decided from the catalogue rather than from the text: void, scalar,
-- and set-returning. #variable_conflict use_column is set on converted bodies
-- only, because a RETURNS TABLE function's output parameter names collide with
-- the column names its own query selects (effective_salary selects
-- base_salary into an OUT parameter called base_salary); without it plpgsql
-- rejects the body as ambiguous. It is not added to already-plpgsql bodies,
-- where it would change existing resolution.
--
-- Conversion costs sql-level inlining. Checked before accepting that: only
-- three of these functions appear in any RLS policy expression
-- (user_can_see_employee, employee_in_branch, employee_company_id) and all
-- three are exempt, so no policy predicate loses inlining.
-- ---------------------------------------------------------------------------

do $gen$
declare
  r        record;
  v_guard  text;
  v_body   text;
  v_def    text;
  v_hdr    text;
  v_rest   text;
  v_tail   text;
  p1       int;
  p2       int;
  v_done   int := 0;
begin
  for r in
    select p.oid, p.proname, l.lanname, p.proretset,
           p.prorettype::regtype::text as rettype,
           p.prosrc,
           pg_get_function_identity_arguments(p.oid) as args,
           (regexp_match(pg_get_function_identity_arguments(p.oid), '(\w+)\s+uuid'))[1] as param
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
       and p.prosrc not ilike '%current_company_id%'
       and p.prosrc not ilike '%is_ssa_unscoped%'
       and p.prosrc not ilike '%assert_same_company%'
       and p.proname not in (select fn from _tg_exempt)
     order by p.proname
  loop
    -- Pick the pattern. The two are labelled in the emitted code because they
    -- read the same and mean different things.
    if r.args ilike 'p_company%' then
      v_guard := format(
        E'  -- tenant guard [claimed]: %I IS the caller''s claim; compared as given (0242)\n'
        '  perform public.assert_same_company(%I);' || E'\n',
        r.param, r.param);
    else
      v_guard := format(
        E'  -- tenant guard [resolved]: owning company looked up from %I via public.%I (0242)\n'
        '  perform public.assert_same_company((select company_id from public.%I where id = %I));' || E'\n',
        r.param, (select tbl from _tg_map where param = r.param),
        (select tbl from _tg_map where param = r.param), r.param);
    end if;

    if r.lanname = 'plpgsql' then
      p1 := regexp_instr(r.prosrc, '\mbegin\M', 1, 1, 0, 'i');
      v_body := left(r.prosrc, p1 + 4) || E'\n' || v_guard || substr(r.prosrc, p1 + 5);
    else
      v_body := rtrim(rtrim(r.prosrc), E' \t\r\n;');
      if r.rettype = 'void' then
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || v_body || E';\nend\n';
      elsif r.proretset then
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || E'  return query\n' || v_body || E';\nend\n';
      else
        v_body := E'\n#variable_conflict use_column\nbegin\n' || v_guard || E'  return (\n' || v_body || E');\nend\n';
      end if;
    end if;

    -- Rebuild the definition by surgery on pg_get_functiondef rather than by
    -- reassembling it from catalogue columns. Reassembly silently drops
    -- whatever attribute you forgot to carry across — STRICT, PARALLEL,
    -- LEAKPROOF, COST, the search_path SET. Surgery cannot.
    v_def  := pg_get_functiondef(r.oid);
    p1     := strpos(v_def, '$function$');
    v_rest := substr(v_def, p1 + 10);
    p2     := strpos(v_rest, '$function$');
    v_hdr  := left(v_def, p1 - 1);
    v_tail := substr(v_rest, p2 + 10);

    if r.lanname = 'sql' then
      v_hdr := regexp_replace(v_hdr, '\mLANGUAGE sql\M', 'LANGUAGE plpgsql', 'i');
    end if;

    execute v_hdr || '$function$' || v_body || '$function$' || v_tail;
    v_done := v_done + 1;
  end loop;

  raise notice '0242 guarded % function(s)', v_done;
end
$gen$;

-- Record the verdicts on the exempt functions in the database too, so a reader
-- who finds one unguarded from psql learns why without reading this file.
do $verdicts$
declare r record;
begin
  for r in select e.fn, e.verdict from _tg_exempt e loop
    if exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.proname = r.fn) then
      execute format(
        'comment on function public.%I(%s) is %L',
        r.fn,
        (select pg_get_function_identity_arguments(p.oid) from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname = r.fn limit 1),
        'TENANT GUARD EXEMPT (0242). ' || r.verdict);
    end if;
  end loop;
end
$verdicts$;

-- ---------------------------------------------------------------------------
-- PART 6. Verification.
--
-- Asserts the PROPERTY — does the function call assert_same_company — not that
-- the loop above ran. Step 1 of this work found four functions misclassified
-- by name, volatility and return type in a single pass; nothing here infers
-- intent from any of those.
-- ---------------------------------------------------------------------------

do $verify$
declare
  v_unguarded text;
  v_count     int;
  v_resolved  int;
  v_claimed   int;
  v_self      text;
begin
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into v_unguarded, v_count
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prosecdef
     and pg_get_function_identity_arguments(p.oid) ilike '%uuid%'
     and p.prosrc not ilike '%current_company_id%'
     and p.prosrc not ilike '%is_ssa_unscoped%'
       and p.prosrc not ilike '%assert_same_company%'
     and p.proname <> 'assert_same_company'
     and p.proname not in (select fn from _tg_exempt);

  if v_count > 0 then
    raise exception '0242 left % SECURITY DEFINER function(s) unguarded: %', v_count, left(v_unguarded, 400)
      using errcode = '42501';
  end if;

  -- Both patterns must actually be present. A generation bug that emitted only
  -- one of them would still pass the check above, because either label calls
  -- assert_same_company.
  select count(*) filter (where p.prosrc like '%tenant guard [resolved]%'),
         count(*) filter (where p.prosrc like '%tenant guard [claimed]%')
    into v_resolved, v_claimed
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace;

  if v_resolved < 50 or v_claimed < 40 then
    raise exception '0242 emitted % resolved and % claimed guards — one of the two patterns did not generate',
      v_resolved, v_claimed;
  end if;

  -- The failure mode the [claimed]/[resolved] labels exist to prevent: a
  -- function resolving a parameter against the very table the parameter names,
  -- which proves nothing. Nothing should compare p_company_id to a lookup
  -- keyed on p_company_id.
  select string_agg(p.proname, ', ')
    into v_self
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosrc ~ 'assert_same_company\(\(select company_id from public\.companies where id = p_company_id\)\)';
  if v_self is not null then
    raise exception '0242 generated a self-resolving guard on: % — the parameter was checked against itself', v_self;
  end if;
end
$verify$;
