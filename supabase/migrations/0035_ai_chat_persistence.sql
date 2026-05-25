-- Persists AI assistant conversations so users can share a transcript later.
-- Two tables: threads (one row per conversation) + messages (one row per turn).
-- RLS is strictly "you see your own"; even super-admins don't read other
-- users' private chats from these tables.

create table if not exists public.ai_chat_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid references public.companies(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.ai_chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.ai_chat_threads(id) on delete cascade,
  role        text not null check (role in ('user','assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists ai_chat_threads_user_id_idx on public.ai_chat_threads(user_id, updated_at desc);
create index if not exists ai_chat_messages_thread_id_idx on public.ai_chat_messages(thread_id, created_at);

alter table public.ai_chat_threads enable row level security;
alter table public.ai_chat_messages enable row level security;

drop policy if exists own_threads on public.ai_chat_threads;
create policy own_threads on public.ai_chat_threads
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists own_messages on public.ai_chat_messages;
create policy own_messages on public.ai_chat_messages
  for all
  using (
    exists (
      select 1 from public.ai_chat_threads t
      where t.id = thread_id and t.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.ai_chat_threads t
      where t.id = thread_id and t.user_id = auth.uid()
    )
  );
