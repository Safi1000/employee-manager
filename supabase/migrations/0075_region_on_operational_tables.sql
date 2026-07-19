-- Region on the remaining operational tables (spec section 3).
--
-- "Every screen filters to the selection — dashboard, employees, attendance,
-- P&L, receivables, incidents, assets." Employees, clients, expenses,
-- inventory and posts already carried branch_id; migration 0074 added it to
-- invoices, payslips and invoice_payments. This covers the rest.
--
-- These are denormalised region tags rather than joins-at-read-time: the
-- region selector filters every list on every screen, and attendance alone is
-- 20k+ rows and grows daily. A tag costs one indexed column; a join to
-- employees→clients on every page load does not stay cheap.
--
-- Same inheritance rule as 0074: the tag is derived from the parent object on
-- write, never picked by the user.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column if not exists branch_id uuid references public.branches(id);
alter table public.attendance_records
  add column if not exists branch_id uuid references public.branches(id);
alter table public.roster_assignments
  add column if not exists branch_id uuid references public.branches(id);
alter table public.cheques
  add column if not exists branch_id uuid references public.branches(id);

create index if not exists idx_incidents_branch   on public.incidents(branch_id);
create index if not exists idx_roster_branch      on public.roster_assignments(branch_id);
create index if not exists idx_cheques_branch     on public.cheques(branch_id);
-- Attendance is always filtered by region *and* date together.
create index if not exists idx_attendance_branch_date
  on public.attendance_records(branch_id, attendance_date);

-- ---------------------------------------------------------------------------
-- 2. Inheritance triggers
-- ---------------------------------------------------------------------------

-- Incident → the site (post) it happened at, else the client.
create or replace function public.inherit_region_incident()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select p.branch_id into v_region from public.posts p where p.id = new.post_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_incidents_region on public.incidents;
create trigger trg_bbb_incidents_region
  before insert or update of post_id, client_id, company_id on public.incidents
  for each row execute function public.inherit_region_incident();

-- Attendance → the employee it belongs to. worked_for_client_id is where the
-- guard actually stood that day (relievers cover other sites), which is the
-- honest region for the day's cost, so it wins when set.
create or replace function public.inherit_region_attendance()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.worked_for_client_id),
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_attendance_region on public.attendance_records;
create trigger trg_bbb_attendance_region
  before insert or update of employee_id, worked_for_client_id, company_id
  on public.attendance_records
  for each row execute function public.inherit_region_attendance();

-- Roster assignment → the post, else the client, else the employee.
create or replace function public.inherit_region_roster()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select p.branch_id into v_region from public.posts p where p.id = new.post_id;
  new.branch_id := coalesce(
    v_region,
    public.region_for_client(new.client_id),
    public.region_for_employee(new.employee_id),
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_roster_region on public.roster_assignments;
create trigger trg_bbb_roster_region
  before insert or update of post_id, client_id, employee_id, company_id
  on public.roster_assignments
  for each row execute function public.inherit_region_roster();

-- Cheque → the client it settles, else the invoice's region. A cheque with
-- neither is a head-office instrument (vendor payment, salary run).
create or replace function public.inherit_region_cheque()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_region uuid;
begin
  select i.branch_id into v_region from public.invoices i where i.id = new.invoice_id;
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    v_region,
    new.branch_id,
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_cheques_region on public.cheques;
create trigger trg_bbb_cheques_region
  before insert or update of client_id, invoice_id, company_id on public.cheques
  for each row execute function public.inherit_region_cheque();

-- Post → its client. posts.branch_id already existed but was set by hand.
create or replace function public.inherit_region_post()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.branch_id := coalesce(
    public.region_for_client(new.client_id),
    new.branch_id,
    public.head_office_region(new.company_id)
  );
  return new;
end;
$$;

drop trigger if exists trg_bbb_posts_region on public.posts;
create trigger trg_bbb_posts_region
  before insert or update of client_id, company_id on public.posts
  for each row execute function public.inherit_region_post();

-- ---------------------------------------------------------------------------
-- 3. Backfill
-- ---------------------------------------------------------------------------

update public.posts p
   set branch_id = coalesce(public.region_for_client(p.client_id),
                            public.head_office_region(p.company_id))
 where p.branch_id is null;

update public.incidents i
   set branch_id = coalesce((select p.branch_id from public.posts p where p.id = i.post_id),
                            public.region_for_client(i.client_id),
                            public.head_office_region(i.company_id))
 where i.branch_id is null;

-- Attendance carries two BEFORE UPDATE triggers that must not see this
-- backfill, so they are suspended for it:
--
--  * trg_attendance_stamp unconditionally re-stamps marked_by_user_id :=
--    auth.uid() on any update. auth.uid() is null in a migration, so leaving
--    it live would erase who marked all 20k+ attendance rows.
--  * trg_attendance_records_enforce_reliever rejects 57 legacy rows written
--    before that rule existed (reliever + Present + no worked_for_client_id).
--    They are pre-existing and out of scope here; the rule still guards every
--    normal write. Backfilling a region tag must not be the thing that has to
--    fix them.
--
-- Only branch_id is written, so neither trigger has real work to do.
alter table public.attendance_records disable trigger trg_attendance_stamp;
alter table public.attendance_records disable trigger trg_attendance_records_enforce_reliever;

update public.attendance_records a
   set branch_id = coalesce(public.region_for_client(a.worked_for_client_id),
                            public.region_for_employee(a.employee_id),
                            public.head_office_region(a.company_id))
 where a.branch_id is null;

alter table public.attendance_records enable trigger trg_attendance_stamp;
alter table public.attendance_records enable trigger trg_attendance_records_enforce_reliever;

update public.roster_assignments r
   set branch_id = coalesce((select p.branch_id from public.posts p where p.id = r.post_id),
                            public.region_for_client(r.client_id),
                            public.region_for_employee(r.employee_id),
                            public.head_office_region(r.company_id))
 where r.branch_id is null;

update public.cheques ch
   set branch_id = coalesce(public.region_for_client(ch.client_id),
                            (select i.branch_id from public.invoices i where i.id = ch.invoice_id),
                            public.head_office_region(ch.company_id))
 where ch.branch_id is null;

-- ---------------------------------------------------------------------------
-- 4. Region-scoping helpers for RLS and for the app's own queries.
--
-- A user pinned to a region (spec §2's RMD: "owns one region … cannot see
-- other regions") is expressed as profiles.branch_id being set. Head-office
-- roles leave it null and get the full selector. No profile has it set today,
-- so this is inert until RMD accounts are created — the selector defaults to
-- consolidated for everyone, exactly as now.
-- ---------------------------------------------------------------------------

create or replace function public.current_region_id()
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = auth.uid();
$$;

-- True when the caller may see the given region: head-office users (no pin)
-- see every region; a pinned user sees only their own.
create or replace function public.can_see_region(p_region_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.current_region_id() is null
      or public.current_region_id() = p_region_id;
$$;
