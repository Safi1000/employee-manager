-- 0521 — An opening-batch line carries its party: client_id and employee_id on
-- opening_balance_lines, passed through to the opening journal entry by
-- post_opening_balances.
--
-- NUMBER: written as 0521 on 2026-10-17. Claim it against
-- supabase_migrations.schema_migrations at apply time; rename the FILE if taken.
--
-- WHY. The ledgers read the GL. ledger_statement() takes a client's lines from
-- journal_lines.client_id on the receivable, and a guard's from
-- journal_lines.employee_id on salaries payable and employee advances; its
-- opening is everything dated before the range. The opening batch could not say
-- whose a line was, so the cutover's opening entry would have arrived with no
-- party at all: every client ledger would open at zero and close wrong by that
-- client's opening, and every guard's September disbursement of August pay
-- would read as a debit from nothing.
--
-- THIS REPLACES the client-ledger fix that was proposed and withdrawn (making
-- ledger_statement read clients.opening_balance). That would double-count the
-- moment the opening posted, because the GL would then hold it too. With the
-- party on the opening line, the ledger needs no change at all.
--
-- The receivable check (ar_control_equals_open_invoices) is unaffected: it reads
-- clients.opening_balance as its subledger by design (0341), and the GL side
-- gets the same total whether or not the lines name a client.
--
-- A party must belong to the batch's company — checked on every insert and
-- update of a line, so a line cannot name another tenant's client or guard.
-- post_opening_balances has six authors (0081, 0242, 0260, 0312, 0319, 0417):
-- amended by surgery, one anchor asserted once.

alter table public.opening_balance_lines
  add column if not exists client_id   uuid references public.clients(id),
  add column if not exists employee_id uuid references public.employees(id);

comment on column public.opening_balance_lines.client_id is
  '0521. The client a receivable opening belongs to. Passed to the opening journal line, where ledger_statement(kind client) reads it.';
comment on column public.opening_balance_lines.employee_id is
  '0521. The employee a payable or advance opening belongs to. Passed to the opening journal line, where ledger_statement(kind guard) reads it.';

create or replace function public.opening_line_party_in_company()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_co uuid;
begin
  if new.client_id is null and new.employee_id is null then return new; end if;
  select company_id into v_co from public.opening_balance_batches where id = new.batch_id;
  if new.client_id is not null
     and (select company_id from public.clients where id = new.client_id) is distinct from v_co then
    raise exception 'That client belongs to another company. An opening line can only name a party of its own batch''s company.'
      using errcode = '23514';
  end if;
  if new.employee_id is not null
     and (select company_id from public.employees where id = new.employee_id) is distinct from v_co then
    raise exception 'That employee belongs to another company. An opening line can only name a party of its own batch''s company.'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke execute on function public.opening_line_party_in_company() from public, anon, authenticated;

drop trigger if exists trg_ob_lines_party_in_company on public.opening_balance_lines;
create trigger trg_ob_lines_party_in_company before insert or update on public.opening_balance_lines
  for each row execute function public.opening_line_party_in_company();

-- The poster passes the party through. post_journal already reads 'client_id'
-- and 'employee_id' off every line (it writes them to journal_lines).
do $$
declare
  v_def  text := pg_get_functiondef('public.post_opening_balances(uuid)'::regprocedure);
  a      text := $a$             'credit',     l.credit,$a$;
  b      text := $b$             'credit',     l.credit,
             'client_id',   l.client_id,     -- 0521: the party travels to the GL
             'employee_id', l.employee_id,$b$;
  v_hits int;
begin
  if position('0521: the party travels to the GL' in v_def) > 0 then
    raise notice '0521: post_opening_balances already passes the party.';
    return;
  end if;
  v_hits := (length(v_def) - length(replace(v_def, a, ''))) / length(a);
  if v_hits <> 1 then
    raise exception '0521 REFUSED: post_opening_balances anchor appears % time(s), expected 1.', v_hits;
  end if;
  execute replace(v_def, a, b);
end $$;

-- ---------------------------------------------------------------------------
-- ASSERTIONS.
-- ---------------------------------------------------------------------------
do $$
begin
  if position($q$nullif(v_line->>'client_id',   '')::uuid$q$ in pg_get_functiondef('public.post_journal(uuid,date,text,text,uuid,boolean,jsonb,uuid,boolean)'::regprocedure)) = 0
  or position($q$nullif(v_line->>'employee_id', '')::uuid$q$ in pg_get_functiondef('public.post_journal(uuid,date,text,text,uuid,boolean,jsonb,uuid,boolean)'::regprocedure)) = 0 then
    raise exception '0521 FAILED: post_journal no longer reads client_id / employee_id off a line, so the party would be dropped on the way to the GL.';
  end if;
  if position('0521: the party travels to the GL' in pg_get_functiondef('public.post_opening_balances(uuid)'::regprocedure)) = 0 then
    raise exception '0521 FAILED: post_opening_balances does not pass the party.';
  end if;
  -- Nothing has posted: the draft batch's lines name no party yet.
  if exists (select 1 from public.opening_balance_lines where client_id is not null or employee_id is not null) then
    raise exception '0521 FAILED: an opening line already names a party; none was expected before the restage.';
  end if;
end $$;

-- Tenant guard assertion (scripts/migration-template.sql).
do $$
declare v_n int; v_who text;
begin
  select count(*), string_agg(g.function_name || '.' || g.parameter_name, ', ')
    into v_n, v_who
    from public.tenant_guard_gaps() g;
  if v_n <> 0 then
    raise exception '0521 REFUSED: tenant_guard_gaps() reports % gap(s): %', v_n, v_who;
  end if;
end $$;
