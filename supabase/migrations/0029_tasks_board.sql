-- ============================================================================
-- Company task board (kanban). One board per company; super admins assign
-- tasks to users; non-admins only see their own.
-- ============================================================================

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  assignee_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  due_date date,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_company_status_idx
  on public.tasks(company_id, status, position);
create index if not exists tasks_assignee_idx
  on public.tasks(assignee_id);

alter table public.tasks enable row level security;

-- SSA: see/manage everything.
drop policy if exists "ssa_all" on public.tasks;
create policy "ssa_all" on public.tasks for all
  using (public.is_super_super_admin()) with check (public.is_super_super_admin());

-- Within a company, admins (super_admin) see/manage everything.
-- Non-admins only see tasks assigned to them.
drop policy if exists "company_visibility" on public.tasks;
create policy "company_visibility" on public.tasks for select
  using (
    company_id = public.current_company_id()
    and (
      assignee_id = auth.uid()
      or created_by = auth.uid()
      or exists (
        select 1 from public.profiles p
         where p.id = auth.uid()
           and p.role = 'super_admin'
      )
    )
  );

-- Admins can insert/update/delete any task in their company.
drop policy if exists "company_admin_write" on public.tasks;
create policy "company_admin_write" on public.tasks for all
  using (
    company_id = public.current_company_id()
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'super_admin'
    )
  )
  with check (
    company_id = public.current_company_id()
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'super_admin'
    )
  );

-- Non-admin assignees can UPDATE their own task (status / description notes)
-- but not reassign / delete / change due date.
drop policy if exists "assignee_self_update" on public.tasks;
create policy "assignee_self_update" on public.tasks for update
  using (assignee_id = auth.uid() and company_id = public.current_company_id())
  with check (assignee_id = auth.uid() and company_id = public.current_company_id());

-- Auto-fill company_id / created_by on insert when missing.
create or replace function public.tasks_set_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := public.current_company_id();
  end if;
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tasks_set_defaults on public.tasks;
create trigger trg_tasks_set_defaults
  before insert or update on public.tasks
  for each row execute function public.tasks_set_defaults();
