-- 0553 — "68 HS" and "PFM" are gone; only 68 HS-PCI-PFM remains
--
-- DECIDED 2026-10-23 (Shayan): "remove all bs like 68 HS (merged into xyzz)
-- merge them remove all previous entries only keep 68 HS/PCI/PFM from clients
-- contracts client profitability xyz".
--
-- 0509 merged the three into one client and moved employees, invoices and the
-- receivable. What it left behind still names the two old clients:
--   * ledger lines tagged with them — August salaries (157,323 + 171,096),
--     September revenue (204,000 + 238,000), and the cash/payable lines of the
--     same payslips — so profitability, region and head-office reports still
--     show "68 HS (merged…)" and "PFM (merged…)" as clients;
--   * two expenses (1,507 and 217, October).
--
-- Ledger lines are immutable, so their tag is not edited. The 0509 way is
-- followed instead: per old client, per account, per region and per month, a
-- "client_merge" entry dated in that month moves the net onto 68 HS-PCI-PFM
-- (credit the old client, debit the merged one, or the reverse). Every account
-- of each old client then nets to zero in every month, and the merged client
-- carries exactly what the three did. No money moves.
--
-- The two expenses are re-pointed (their journals follow, as for any edited
-- expense). Both are approved and locked, so each is unapproved, re-pointed
-- and its original approval restored, leaving its unapproved_at stamp as the
-- trail. Every other table that can name a client is re-pointed too — today
-- none does, and the migration asserts so afterwards.
--
-- The rows themselves cannot be deleted while immutable ledger lines name
-- them, so they are marked clients.merged_into and hidden from every screen by
-- a restrictive read policy; client_statement_loaded (a definer function, which
-- RLS does not reach) skips them by surgery on its one anchor.

do $mig$
declare
  v_co   constant uuid := '7f7899a0-edd2-4491-a40d-f81b54c68d1e';
  v_main constant uuid := 'c528cb54-89b2-4ec3-b62c-0833fb1a9033';
  v_old  constant uuid[] := array['a4553963-0772-42aa-9589-de7217b691c8', '4288ef93-dd35-408a-840d-407544d14140']::uuid[];
  g record; v_lines jsonb; v_date date; r record; v_n bigint;
begin
  if (select name from public.clients where id = v_main) is distinct from '68 HS-PCI-PFM' then
    raise exception '0553 REFUSED: the client to keep is not "68 HS-PCI-PFM".';
  end if;

  -- 1. Ledger: one entry per old client per month, a line pair per account and region.
  for g in
    select jl.client_id, date_trunc('month', je.entry_date)::date m
      from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where jl.client_id = any (v_old)
     group by 1, 2
     order by 2, 1
  loop
    v_lines := '[]'::jsonb;
    for r in
      select jl.account_id, jl.branch_id, sum(jl.debit - jl.credit) net
        from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
       where jl.client_id = g.client_id and date_trunc('month', je.entry_date)::date = g.m
       group by 1, 2 having sum(jl.debit - jl.credit) <> 0
    loop
      v_lines := v_lines || jsonb_build_array(
        jsonb_build_object('account_id', r.account_id, 'region', r.branch_id, 'client_id', g.client_id,
                           'debit', greatest(-r.net, 0), 'credit', greatest(r.net, 0)),
        jsonb_build_object('account_id', r.account_id, 'region', r.branch_id, 'client_id', v_main,
                           'debit', greatest(r.net, 0), 'credit', greatest(-r.net, 0)));
    end loop;
    if jsonb_array_length(v_lines) = 0 then continue; end if;
    v_date := least((g.m + interval '1 month - 1 day')::date, current_date);
    perform public.post_journal(
      v_co, v_date,
      'Client merge (0553): ' || (select name from public.clients where id = g.client_id) || ' — ' ||
        to_char(g.m, 'FMMonth YYYY') || ' ledger moved to 68 HS-PCI-PFM',
      'client_merge', g.client_id, false, v_lines, null);
  end loop;

  -- 2. The two expenses, and anything else that still names an old client.
  -- Both are approved and locked: the lock allows unapprove → edit → approve as
  -- separate steps, so it is done that way. The expense keeps its unapproved_at
  -- stamp as the trail, and its original approval (date and approver) is put
  -- back — the only change is the client tag Shayan asked for.
  for r in select id, approved_at, approved_by from public.expenses where client_id = any (v_old) loop
    if r.approved_at is not null then
      update public.expenses set approved_at = null where id = r.id;
    end if;
    update public.expenses set client_id = v_main where id = r.id;
    if r.approved_at is not null then
      update public.expenses set approved_at = r.approved_at, approved_by = r.approved_by where id = r.id;
    end if;
  end loop;
  for r in
    select c.conrelid::regclass::text tbl, a.attname col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.clients'::regclass
       and c.conrelid not in ('public.journal_lines'::regclass, 'public.expenses'::regclass)
  loop
    execute format('update %s set %I = $1 where %I = any ($2)', r.tbl, r.col, r.col) using v_main, v_old;
  end loop;

  -- 3. Asserted: the old clients carry nothing — every account nets to zero in
  -- every month, and no table but the immutable ledger names them.
  if exists (
    select 1 from public.journal_lines jl join public.journal_entries je on je.id = jl.journal_entry_id
     where jl.client_id = any (v_old)
     group by jl.client_id, jl.account_id, date_trunc('month', je.entry_date)
    having sum(jl.debit - jl.credit) <> 0) then
    raise exception '0553 REFUSED: an old client still carries a balance after the reclass.';
  end if;
  for r in
    select c.conrelid::regclass::text tbl, a.attname col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.clients'::regclass and c.conrelid <> 'public.journal_lines'::regclass
  loop
    execute format('select count(*) from %s where %I = any ($1)', r.tbl, r.col) into v_n using v_old;
    if v_n > 0 then raise exception '0553 REFUSED: %.% still names an old client (% rows).', r.tbl, r.col, v_n; end if;
  end loop;
end $mig$;

-- 4. Hidden everywhere.
alter table public.clients add column if not exists merged_into uuid references public.clients(id);
update public.clients set merged_into = 'c528cb54-89b2-4ec3-b62c-0833fb1a9033'
 where id in ('a4553963-0772-42aa-9589-de7217b691c8', '4288ef93-dd35-408a-840d-407544d14140') and merged_into is null;
comment on column public.clients.merged_into is
  'DECIDED 2026-10-23 (0553). This client was merged into that one and is gone from every screen. The row stays only '
  'because immutable ledger lines name it; its every account nets to zero (client_merge entries).';
drop policy if exists not_merged on public.clients;
create policy not_merged on public.clients as restrictive for select using (merged_into is null);

do $surgery$
declare
  v_def text := pg_get_functiondef('public.client_statement_loaded(date, date, text, uuid)'::regprocedure);
  v_anchor constant text := E'       and not public.scenario_excluded(c.id, c.branch_id)  /* 0516 scenario */\n';
  v_n int;
begin
  if position('0553' in v_def) > 0 then return; end if;  -- replay
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_n <> 1 then raise exception '0553 REFUSED: the anchor appears % times in client_statement_loaded.', v_n; end if;
  v_def := replace(v_def, v_anchor, v_anchor || E'       and c.merged_into is null  /* 0553: merged clients are gone */\n');
  execute v_def;
end $surgery$;

do $check$
begin
  if exists (select 1 from public.client_statement_loaded('2026-08-01', '2026-10-31', 'revenue', '7f7899a0-edd2-4491-a40d-f81b54c68d1e') s
              where s.client_id in ('a4553963-0772-42aa-9589-de7217b691c8', '4288ef93-dd35-408a-840d-407544d14140')) then
    raise exception '0553 REFUSED: client profitability still lists a merged client.';
  end if;
  raise notice '0553: 68 HS and PFM folded into 68 HS-PCI-PFM and hidden.';
end $check$;
