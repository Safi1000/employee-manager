-- 0606 — comments on a record, seen only by whoever is tagged
--
-- Shayan, 29 Oct 2026: the CEO "demanded a comment section … where he can give
-- comments on things he feel like are not right or need better understanding
-- … not just CEO rather anyone who has a question to can directly tag and then
-- who is tagged can also reply". Then: "only those who are being tagged can
-- see and yes an email to be also sent to whoever is tagged and replies", and
-- "specific say expense is tagged … is shown to other tagged person as well".
--
--   comment_threads       one conversation about one record (expense, invoice,
--                         employee, payslip). Carries the record's label and a
--                         link, written HERE from the record itself — never
--                         from the browser — so a tagged person sees exactly
--                         which expense it is even without access to Expenses.
--   comment_participants  who is in it: the starter and everyone tagged. THE
--                         visibility rule: a thread, its messages and its
--                         participants are readable only by its participants.
--                         Not by admins, not by the record's owners — DECIDED,
--                         Shayan's words above.
--   comment_messages      what was said.
--   comment_mail_log      one row per (message, recipient other than the
--                         author). Written by the insert trigger BEFORE any
--                         mail goes; the Edge Function comment-mail reads it,
--                         sends, and marks each sent / failed. A failure stays
--                         visible and is retried every 10 minutes — the row is
--                         the record, not a fire-and-forget fetch.
--
-- Writes only through four functions (no table grants beyond SELECT):
--   start_comment_thread(type, record id, body, tagged[])  — the starter must
--     hold the record type's .view key and reach the record (company and
--     region); tags must be active logins of the same company.
--   add_comment(thread, body, tag_more[])  — participants only.
--   resolve_comment_thread(thread, resolved)  — the starter only.
--   mark_comment_thread_read(thread)  — a participant's own read mark.
--   comment_people()  — names of the caller's active colleagues, for tagging
--     (only super admins can read profiles, so names travel this way and are
--     stored on the thread for everyone in it).
--
-- Asserted: a thread started by Shayan on an expense, tagging the HR login,
-- is readable by both and by no third login; the label names the expense;
-- a reply by HR queues one mail, to Shayan; HR cannot resolve it; a stranger
-- cannot reply; no security, tenant or branch gap (rolled back by a sentinel
-- whose message is checked).

create table if not exists public.comment_threads (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  record_type  text not null check (record_type in ('expense', 'invoice', 'employee', 'payslip')),
  record_id    uuid not null,
  record_label text not null,
  record_path  text not null,
  created_by   uuid not null references public.profiles(id),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references public.profiles(id)
);
create index if not exists comment_threads_record on public.comment_threads (record_type, record_id);

create table if not exists public.comment_participants (
  thread_id    uuid not null references public.comment_threads(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  name         text,
  added_by     uuid references public.profiles(id),
  added_at     timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (thread_id, user_id)
);
create index if not exists comment_participants_user on public.comment_participants (user_id);

create table if not exists public.comment_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.comment_threads(id) on delete cascade,
  author_id  uuid not null references public.profiles(id),
  author_name text,
  body       text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists comment_messages_thread on public.comment_messages (thread_id, created_at);

create table if not exists public.comment_mail_log (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references public.comment_messages(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'no_address')),
  email        text,
  error        text,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  unique (message_id, recipient_id)
);
comment on table public.comment_mail_log is
  'DECIDED 0606: one row per comment message per recipient (everyone in the thread but the author). Written by the trigger before sending; comment-mail marks sent / failed / no_address. Service role only.';

-- Participation, read without RLS so the policies below do not recurse.
create or replace function public.is_comment_participant(p_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 0606. Is the caller in this thread? A boolean about the caller only.
  select exists (select 1 from public.comment_participants p
                  where p.thread_id = p_thread_id and p.user_id = auth.uid());
$$;
comment on function public.is_comment_participant(uuid) is
  'TENANT GUARD EXEMPT: answers only whether the CALLER is a participant; reveals nothing about the thread (0606).';
revoke all on function public.is_comment_participant(uuid) from public, anon;
grant execute on function public.is_comment_participant(uuid) to authenticated;

alter table public.comment_threads enable row level security;
alter table public.comment_participants enable row level security;
alter table public.comment_messages enable row level security;
alter table public.comment_mail_log enable row level security;
revoke all on public.comment_threads, public.comment_participants, public.comment_messages, public.comment_mail_log from anon, authenticated;
grant select on public.comment_threads, public.comment_participants, public.comment_messages to authenticated;

drop policy if exists participants_read on public.comment_threads;
create policy participants_read on public.comment_threads for select using (
  company_id = (select public.current_company_id()) and public.is_comment_participant(id));
drop policy if exists participants_read on public.comment_participants;
create policy participants_read on public.comment_participants for select using (public.is_comment_participant(thread_id));
drop policy if exists participants_read on public.comment_messages;
create policy participants_read on public.comment_messages for select using (public.is_comment_participant(thread_id));

-- The record a thread is about: its company, region, label and link. Built
-- from the record, so the label cannot be made to say something else.
create or replace function public.comment_record_info(p_type text, p_record_id uuid,
  out company_id uuid, out region uuid, out label text, out path text)
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0606. Internal: called only by start_comment_thread, which guards it.
  begin
    if p_type = 'expense' then
      select e.company_id, coalesce(e.branch_id, c.branch_id),
             'Expense · ' || to_char(e.expense_date, 'DD Mon YYYY') || coalesce(' · ' || ec.name, '')
               || ' · PKR ' || to_char(e.amount, 'FM999,999,999') || coalesce(' · ' || left(nullif(btrim(e.description), ''), 60), ''),
             '/app/expenses?focus=' || e.id || '&focusType=expenses'
        into company_id, region, label, path
        from public.expenses e left join public.clients c on c.id = e.client_id
        left join public.expense_categories ec on ec.id = e.category_id where e.id = p_record_id;
    elsif p_type = 'invoice' then
      select i.company_id, coalesce(i.branch_id, c.branch_id),
             'Invoice ' || coalesce(i.invoice_number, '') || coalesce(' · ' || c.name, '')
               || ' · PKR ' || to_char(coalesce(i.total_due, i.invoice_amount), 'FM999,999,999'),
             '/app/invoices?focus=' || i.id || '&focusType=invoices'
        into company_id, region, label, path
        from public.invoices i left join public.clients c on c.id = i.client_id where i.id = p_record_id;
    elsif p_type = 'employee' then
      select e.company_id, e.branch_id, 'Employee · ' || e.full_name || coalesce(' (' || e.employee_code || ')', ''),
             '/app/employees?focus=' || e.id || '&focusType=employees'
        into company_id, region, label, path
        from public.employees e where e.id = p_record_id;
    elsif p_type = 'payslip' then
      select s.company_id, s.branch_id,
             'Payslip · ' || e.full_name || ' · ' || to_char(s.period_month, 'Mon YYYY') || ' · PKR ' || to_char(s.net_salary, 'FM999,999,999'),
             '/app/payroll?focus=' || s.id || '&focusType=payslips'
        into company_id, region, label, path
        from public.payslips s join public.employees e on e.id = s.employee_id where s.id = p_record_id;
    end if;
  end $$;
comment on function public.comment_record_info(text, uuid) is
  'TENANT GUARD EXEMPT: internal, no EXECUTE for authenticated; start_comment_thread asserts company and region on its result (0606).';
revoke all on function public.comment_record_info(text, uuid) from public, anon, authenticated;

-- Tagged ids: distinct, not the caller, active logins of the caller's company.
create or replace function public.comment_valid_tags(p_tagged uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
  -- 0606. Internal: the tag list, checked.
  declare v uuid[] := (select array_agg(distinct x) from unnest(coalesce(p_tagged, '{}')) x where x is not null and x <> auth.uid());
  begin
    if exists (select 1 from unnest(coalesce(v, '{}')) x
                where not exists (select 1 from public.profiles p where p.id = x and p.company_id = public.current_company_id() and p.disabled_at is null)) then
      raise exception 'Row not found' using errcode = '42501';
    end if;
    return coalesce(v, '{}');
  end $$;
comment on function public.comment_valid_tags(uuid[]) is
  'TENANT GUARD EXEMPT: internal, no EXECUTE for authenticated; checks every id against the caller''s company (0606).';
revoke all on function public.comment_valid_tags(uuid[]) from public, anon, authenticated;

-- Names. Only super admins can read other profiles, so a thread keeps the
-- names of the people in it, and the tag picker gets names and nothing else.
create or replace function public.comment_person_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- 0606. Internal: a display name, for the thread's own record.
  select coalesce(nullif(btrim(full_name), ''), email) from public.profiles where id = p_user_id;
$$;
comment on function public.comment_person_name(uuid) is 'TENANT GUARD EXEMPT: internal, no EXECUTE for authenticated (0606).';
revoke all on function public.comment_person_name(uuid) from public, anon, authenticated;

create or replace function public.comment_people()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  -- 0606. Who can be tagged: the caller's company's active logins, name only.
  select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email)
    from public.profiles p
   where p.company_id = public.current_company_id() and p.disabled_at is null and p.id <> auth.uid()
   order by 2;
$$;
comment on function public.comment_people() is
  'TENANT GUARD EXEMPT: no argument; the caller''s own company''s active logins, id and name only — the tag picker (0606).';
revoke all on function public.comment_people() from public, anon;
grant execute on function public.comment_people() to authenticated;

create or replace function public.start_comment_thread(p_record_type text, p_record_id uuid, p_body text, p_tagged uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0606. Open a conversation about one record and tag people into it.
  declare v_info record; v_tags uuid[]; v_thread uuid; v_key text;
  begin
    v_key := case p_record_type when 'expense' then 'expenses.view' when 'invoice' then 'invoices.view'
                                when 'employee' then 'employees.view' when 'payslip' then 'payroll.view' end;
    if v_key is null then raise exception 'Comments are not available on %.', p_record_type; end if;
    perform public.require_perm(v_key);
    if coalesce(btrim(p_body), '') = '' then raise exception 'Write something first.'; end if;

    select * into v_info from public.comment_record_info(p_record_type, p_record_id);
    if v_info.company_id is null then raise exception 'Row not found' using errcode = '42501'; end if;
    -- tenant guard [resolved]: p_record_id's company looked up from the record itself
    perform public.assert_same_company((select i.company_id from public.comment_record_info(p_record_type, p_record_id) i));
    perform public.assert_branch_writable(v_info.region);

    v_tags := public.comment_valid_tags(p_tagged);
    if cardinality(v_tags) = 0 then raise exception 'Tag at least one person.'; end if;

    insert into public.comment_threads (company_id, record_type, record_id, record_label, record_path, created_by)
    values (v_info.company_id, p_record_type, p_record_id, v_info.label, v_info.path, auth.uid())
    returning id into v_thread;
    insert into public.comment_participants (thread_id, user_id, name, added_by, last_read_at)
    values (v_thread, auth.uid(), public.comment_person_name(auth.uid()), auth.uid(), now());
    insert into public.comment_participants (thread_id, user_id, name, added_by)
    select v_thread, t, public.comment_person_name(t), auth.uid() from unnest(v_tags) t;
    insert into public.comment_messages (thread_id, author_id, author_name, body)
    values (v_thread, auth.uid(), public.comment_person_name(auth.uid()), btrim(p_body));
    return v_thread;
  end $$;
comment on function public.start_comment_thread(text, uuid, text, uuid[]) is
  '0606: open a comment thread on an expense / invoice / employee / payslip. Needs that type''s .view key and the record''s company and region; tags must be active logins of the same company.';

create or replace function public.add_comment(p_thread_id uuid, p_body text, p_tag_more uuid[] default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
  -- 0606. Reply in a thread you are in; optionally tag more people.
  declare v_tags uuid[]; v_msg uuid;
  begin
    -- tenant guard [resolved]: the thread's company, then participation.
    perform public.assert_same_company((select company_id from public.comment_threads where id = p_thread_id));
    if not public.is_comment_participant(p_thread_id) then raise exception 'Row not found' using errcode = '42501'; end if;
    if coalesce(btrim(p_body), '') = '' then raise exception 'Write something first.'; end if;
    v_tags := public.comment_valid_tags(p_tag_more);
    insert into public.comment_participants (thread_id, user_id, name, added_by)
    select p_thread_id, t, public.comment_person_name(t), auth.uid() from unnest(v_tags) t
    on conflict (thread_id, user_id) do nothing;
    insert into public.comment_messages (thread_id, author_id, author_name, body)
    values (p_thread_id, auth.uid(), public.comment_person_name(auth.uid()), btrim(p_body))
    returning id into v_msg;
    update public.comment_participants set last_read_at = now() where thread_id = p_thread_id and user_id = auth.uid();
    return v_msg;
  end $$;
comment on function public.add_comment(uuid, text, uuid[]) is '0606: reply in a comment thread (participants only), optionally tagging more people in.';

create or replace function public.resolve_comment_thread(p_thread_id uuid, p_resolved boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
  -- 0606. The person who started a thread closes or reopens it.
  declare n int;
  begin
    -- tenant guard [resolved]: the thread's company; then the starter only.
    perform public.assert_same_company((select company_id from public.comment_threads where id = p_thread_id));
    update public.comment_threads
       set resolved_at = case when p_resolved then now() end, resolved_by = case when p_resolved then auth.uid() end
     where id = p_thread_id and created_by = auth.uid();
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'Only the person who started this thread can resolve it.' using errcode = '42501'; end if;
  end $$;
comment on function public.resolve_comment_thread(uuid, boolean) is '0606: the starter marks a comment thread resolved / open.';

create or replace function public.mark_comment_thread_read(p_thread_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  -- 0606. The caller's own read mark; touches no one else's row.
  update public.comment_participants set last_read_at = now()
   where thread_id = p_thread_id and user_id = auth.uid();
$$;
comment on function public.mark_comment_thread_read(uuid) is
  'TENANT GUARD EXEMPT: writes only the caller''s own participant row (0606).';

create or replace function public.my_unread_comment_threads()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  -- 0606. Threads with a message from someone else since the caller last read.
  select count(*)::int from public.comment_participants p
   where p.user_id = auth.uid()
     and exists (select 1 from public.comment_messages m
                  where m.thread_id = p.thread_id and m.author_id <> auth.uid()
                    and m.created_at > coalesce(p.last_read_at, '-infinity'::timestamptz));
$$;
comment on function public.my_unread_comment_threads() is '0606: the sidebar''s unread count. INVOKER — counts only the caller''s own threads.';
revoke all on function public.my_unread_comment_threads() from public, anon;
grant execute on function public.my_unread_comment_threads() to authenticated;

do $grants$
declare f text;
begin
  foreach f in array array['start_comment_thread(text, uuid, text, uuid[])', 'add_comment(uuid, text, uuid[])',
                           'resolve_comment_thread(uuid, boolean)', 'mark_comment_thread_read(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $grants$;
insert into public.api_function_gates (function_name, any_of, reason) values
  ('start_comment_thread', null, 'EXEMPT 0606: needs the record type''s .view key, checked inside'),
  ('add_comment', null, 'EXEMPT 0606: participants only, checked inside'),
  ('resolve_comment_thread', null, 'EXEMPT 0606: the thread''s starter only, checked inside'),
  ('mark_comment_thread_read', null, 'EXEMPT 0606: the caller''s own read mark'),
  ('is_comment_participant', null, 'EXEMPT 0606: a boolean about the caller'),
  ('comment_people', null, 'EXEMPT 0606: names of the caller''s colleagues, for tagging'),
  ('my_unread_comment_threads', null, 'EXEMPT 0606: the caller''s own unread count')
on conflict (function_name) do nothing;

-- Mail: queue first, then wake the sender.
create or replace function public.invoke_comment_mail()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
  -- 0606. pg_net's door to the comment-mail Edge Function.
  declare v_key text; v_url text; v_id bigint;
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
    if v_key is null then return null; end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url' limit 1;
    v_url := coalesce(v_url, 'https://mmkfpnshxjcyijhuydgr.supabase.co');
    select net.http_post(url := v_url || '/functions/v1/comment-mail',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      body := '{}'::jsonb, timeout_milliseconds := 60000) into v_id;
    return v_id;
  end $$;
comment on function public.invoke_comment_mail() is 'TENANT GUARD EXEMPT: no argument; called by the comment trigger and pg_cron (0606).';
revoke all on function public.invoke_comment_mail() from public, anon, authenticated;

create or replace function public.queue_comment_mail()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
  -- 0606. Everyone in the thread but the author is owed this message.
  begin
    insert into public.comment_mail_log (message_id, recipient_id)
    select new.id, p.user_id from public.comment_participants p
     where p.thread_id = new.thread_id and p.user_id <> new.author_id
    on conflict (message_id, recipient_id) do nothing;
    perform public.invoke_comment_mail();
    return new;
  end $$;
drop trigger if exists trg_queue_comment_mail on public.comment_messages;
create trigger trg_queue_comment_mail after insert on public.comment_messages
  for each row execute function public.queue_comment_mail();

do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'comment-mail-retry';
  perform cron.schedule('comment-mail-retry', '*/10 * * * *',
    'select public.invoke_comment_mail() where exists (select 1 from public.comment_mail_log where status = ''pending'' or (status = ''failed'' and attempts < 5))');
end $cron$;

do $test$
declare
  v_boss constant uuid := 'd2f4c9c0-7e33-4d5f-80aa-3d04cf657f12';
  v_hr   constant uuid := 'c27a9602-6776-401a-a2c1-d755124b931b';
  v_other uuid := (select id from public.profiles where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e'
                    and id not in ('d2f4c9c0-7e33-4d5f-80aa-3d04cf657f12', 'c27a9602-6776-401a-a2c1-d755124b931b')
                    and disabled_at is null limit 1);
  v_exp uuid := (select id from public.expenses where company_id = '7f7899a0-edd2-4491-a40d-f81b54c68d1e' order by created_at desc limit 1);
  v_thread uuid; v_label text; v_msg text; v_n int;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_boss, 'role', 'authenticated')::text, true);
    v_thread := public.start_comment_thread('expense', v_exp, 'Why is this so high?', array[v_hr]);
    select record_label into v_label from public.comment_threads where id = v_thread;
    if v_label not like 'Expense · %' then raise exception '0606 REFUSED: the label says "%".', v_label; end if;
    if exists (select 1 from public.comment_participants where thread_id = v_thread and name is null)
       or exists (select 1 from public.comment_messages where thread_id = v_thread and author_name is null) then
      raise exception '0606 REFUSED: a participant or author has no stored name.';
    end if;
    if (select count(*) from public.comment_mail_log l join public.comment_messages m on m.id = l.message_id
         where m.thread_id = v_thread and l.recipient_id = v_hr) <> 1 then
      raise exception '0606 REFUSED: starting the thread did not queue one mail to the tagged login.';
    end if;

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', v_hr, 'role', 'authenticated')::text, true);
    select count(*) into v_n from public.comment_messages where thread_id = v_thread;
    if v_n <> 1 then raise exception '0606 REFUSED: the tagged login reads % messages, not 1.', v_n; end if;
    perform public.add_comment(v_thread, 'It covers two months.', null);
    v_msg := null;
    begin perform public.resolve_comment_thread(v_thread, true); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Only the person who started this thread can resolve it.' then raise exception '0606 REFUSED: HR resolving said "%".', v_msg; end if;

    perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    select count(*) into v_n from public.comment_threads where id = v_thread;
    if v_n <> 0 then raise exception '0606 REFUSED: an untagged login can see the thread.'; end if;
    v_msg := null;
    begin perform public.add_comment(v_thread, 'Me too', null); exception when others then get stacked diagnostics v_msg = message_text; end;
    if v_msg is distinct from 'Row not found' then raise exception '0606 REFUSED: an untagged reply said "%".', v_msg; end if;
    execute 'reset role';

    if (select count(*) from public.comment_mail_log l join public.comment_messages m on m.id = l.message_id
         where m.thread_id = v_thread and m.author_id = v_hr and l.recipient_id = v_boss) <> 1 then
      raise exception '0606 REFUSED: the reply did not queue exactly one mail, to the starter.';
    end if;
    raise exception '0606-SENTINEL';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg <> '0606-SENTINEL' then raise; end if;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  if exists (select 1 from public.security_gaps()) then raise exception '0606 REFUSED: security_gaps() reports a gap.'; end if;
  if exists (select 1 from public.tenant_guard_gaps()) then raise exception '0606 REFUSED: tenant_guard_gaps() reports a gap.'; end if;
  if exists (select 1 from public.branch_guard_gaps() where function_name ~ 'comment') then raise exception '0606 REFUSED: branch_guard_gaps() reports a comment function.'; end if;
end $test$;
