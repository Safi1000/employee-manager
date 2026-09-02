-- 0337 — a client can be marked internal, and GGS Relief Pool is one.
--
-- THE PROBLEM. "GGS Relief Pool" is a row in public.clients, but it is not a
-- customer. It exists so that a guard between postings has somewhere to be
-- assigned — 4 deployments, 1 site and 2 employees point at it today. It has no
-- contract, no invoice and no receivable, and it never will.
--
-- It should not appear on the Clients page, where every other row is somebody
-- who gets billed. It MUST keep appearing in Assignments & Pay, because that is
-- the entire reason it exists.
--
-- WHY NOT DELETE IT. Because it cannot be deleted without breaking exactly the
-- screen it must keep working: 4 deployments, 1 site and 2 employees reference
-- it. Deleting it would either fail on the foreign keys or orphan two guards'
-- assignments. Hiding is not the lesser option here, it is the correct one.
--
-- WHY A COLUMN AND NOT A NAME FILTER. A page that hides rows whose name matches
-- '%relief%' is a page that will one day hide a customer called Relief
-- Foundation, and nothing will say why. The distinction being drawn is real and
-- deserves to be stated in the data: this row is an internal placeholder, not a
-- customer. Any future pseudo-client — an unassigned pool, a training bench —
-- gets the same flag and the same behaviour without another code change.
--
-- WHAT THIS FILE DOES NOT DO. It does not filter anything: the column is
-- inert until a screen reads it, and the Clients page reading it is in the same
-- commit. Invoices, Contracts and Receivables still list internal clients in
-- their pickers. That is arguably wrong too, but it is a wider change than was
-- asked for, and a client that cannot be invoiced showing up in an invoice
-- picker is a smaller problem than one that quietly vanishes from a screen
-- somebody was told to check.

-- ---------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column if not exists is_internal boolean not null default false;

comment on column public.clients.is_internal is
  'True for a client row that is an internal placeholder rather than a customer — a relief pool, an unassigned bench. Hidden from the Clients page; still available everywhere a guard is assigned or paid. Never invoiced.';

-- ---------------------------------------------------------------------------
-- 2. GGS Relief Pool is one.
--
-- Matched by name, reported by count, and NOT asserted to be exactly one:
-- production has this row and dev may not, so a hard assertion would refuse on
-- whichever database happens not to carry the fixture. What IS asserted is the
-- dangerous direction — that the match did not sweep up a real customer.
-- ---------------------------------------------------------------------------
do $flag$
declare
  v_n int;
  v_names text;
begin
  select count(*), string_agg(name, ', ')
    into v_n, v_names
    from public.clients
   where name ilike '%relief pool%';

  if v_n = 0 then
    raise notice '0337: no client matching ''%%relief pool%%'' on this database, column added and nothing flagged';
    return;
  end if;

  -- The dangerous direction: a customer swept up by the pattern. An internal
  -- placeholder has no contract and no invoice — if a match has either, it is
  -- somebody's client and this file must not touch it.
  if exists (
    select 1 from public.clients c
     where c.name ilike '%relief pool%'
       and (exists (select 1 from public.contracts k where k.client_id = c.id)
         or exists (select 1 from public.invoices i where i.client_id = c.id))
  ) then
    raise exception
      '0337 FAILED: a client matching ''%%relief pool%%'' has a contract or an invoice, so it is a real customer, not a placeholder. Flag it by id instead of by name.';
  end if;

  update public.clients set is_internal = true where name ilike '%relief pool%';
  raise notice '0337: flagged % client(s) as internal: %', v_n, v_names;
end
$flag$;

-- ---------------------------------------------------------------------------
-- PROOF
--
-- (a) the column exists, is NOT NULL, and defaults to false — so every existing
--     client is a customer unless something says otherwise, which is the safe
--     default: a new flag that defaulted to true would hide the entire Clients
--     page;
-- (b) no client with a contract or an invoice is flagged. This is the assertion
--     that matters: flagging a real customer removes them from the page where
--     they are managed, and nothing else would report it;
-- (c) the assignment surface is UNTOUCHED. Every deployment, site and employee
--     that pointed at an internal client still does. This file hides a row from
--     one page; if it had cost the Relief Pool its assignments it would have
--     done the exact thing it was written to avoid.
-- ---------------------------------------------------------------------------
do $proof$
declare
  v_null   text;
  v_def    text;
  v_flagged int;
  v_dep    int;
  v_sites  int;
  v_emp    int;
begin
  -- (a)
  select is_nullable, coalesce(column_default, '(none)')
    into v_null, v_def
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients' and column_name = 'is_internal';
  if v_null is null then
    raise exception '0337 FAILED: clients.is_internal was not created';
  end if;
  if v_null <> 'NO' then
    raise exception '0337 FAILED: clients.is_internal is nullable — a three-valued hidden flag has a state nobody defined';
  end if;
  if v_def not like 'false%' then
    raise exception '0337 FAILED: clients.is_internal defaults to %, not false — new clients would be hidden', v_def;
  end if;

  -- (b)
  if exists (
    select 1 from public.clients c
     where c.is_internal
       and (exists (select 1 from public.contracts k where k.client_id = c.id)
         or exists (select 1 from public.invoices i where i.client_id = c.id))
  ) then
    raise exception
      '0337 FAILED: a client with a contract or an invoice is flagged internal — that is a customer being hidden from the page they are managed on';
  end if;

  -- (c)
  select count(*) into v_flagged from public.clients where is_internal;
  select count(*) into v_dep   from public.deployments d
    join public.clients c on c.id = d.client_id where c.is_internal;
  select count(*) into v_sites from public.sites s
    join public.clients c on c.id = s.client_id where c.is_internal;
  select count(*) into v_emp   from public.employees e
    join public.clients c on c.id = e.client_id where c.is_internal;

  raise notice
    '0337 OK: clients.is_internal is NOT NULL default false; % client(s) flagged, none of them holding a contract or invoice; their assignment surface is intact — % deployment(s), % site(s), % employee(s) still point at them.',
    v_flagged, v_dep, v_sites, v_emp;
end
$proof$;
