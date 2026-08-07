-- 0175: office staff are posted to a REGION, and the region is their site.
--
-- A guard's site comes from their open deployment row, because a guard stands
-- at a client's site. Office staff have no client and no deployment — they work
-- at Head Office, or at a regional office — so Assignments & Pay showed them as
-- one flat list with no place attached to anybody.
--
-- The region (public.branches) IS the office-staff equivalent of a site, and
-- employees.branch_id already carries it. Nothing new is stored: this migration
-- only guarantees the column is actually populated, so the site level in
-- Assignments & Pay can be built from it without a "no region recorded" bucket
-- swallowing the entire department on day one.

-- 1. Backfill. Every office-staff member without a region goes to their own
--    company's head office. Scoped by company_id — a company's staff must never
--    be attached to another company's branch.
update public.employees e
set branch_id = (
  select b.id from public.branches b
  where b.company_id = e.company_id
  order by b.is_head_office desc nulls last, b.created_at asc
  limit 1
)
where e.category = 'office_staff'
  and e.branch_id is null
  and exists (select 1 from public.branches b where b.company_id = e.company_id);

-- 2. Keep it populated. Office staff created or transferred without a region
--    would otherwise reappear in the unplaced bucket the backfill just emptied.
--    Head office is the right default: it is where someone with no stated
--    regional posting actually sits.
create or replace function public.default_office_staff_branch()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.category = 'office_staff' and new.branch_id is null then
    select b.id into new.branch_id
    from public.branches b
    where b.company_id = new.company_id
    order by b.is_head_office desc nulls last, b.created_at asc
    limit 1;
  end if;
  return new;
end $function$;

drop trigger if exists trg_default_office_staff_branch on public.employees;
create trigger trg_default_office_staff_branch
before insert or update of category, branch_id on public.employees
for each row execute function public.default_office_staff_branch();
