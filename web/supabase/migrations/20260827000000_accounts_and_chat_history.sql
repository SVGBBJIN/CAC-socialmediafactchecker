-- Accounts + cloud chat history for the fact-checker's library.
--
-- Applied directly to the project (vsjlvkivsvrjplkscgrz) via the Supabase MCP tools; this
-- file is the record of that migration, not something a build step runs — there is no
-- migration runner wired into web/ (see web/README.md). Re-run it by hand (`supabase db
-- push`, or paste into the SQL editor) against a fresh project if this ever needs to be
-- reproduced elsewhere.

-- Profiles: one row per auth.users row, kept in sync by a trigger below.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id);

-- Populate profiles automatically on signup — the client never inserts into this table
-- directly.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', null));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Chat history. One row per library entry (a check plus its follow-ups); `id` is the
-- same uuid the client already generates for a library entry (see public/app.js's
-- `runCheck`), so upserting from the client is idempotent and needs no id translation.
--
-- `data` carries the full entry (prompt, rawAnswer, sources, followups, timestamps, …)
-- as the client's own localStorage shape — kept as jsonb rather than modeled column by
-- column so the client's entry shape can keep evolving without a migration on every
-- field it adds. title/url/platform/status are pulled out alongside it only because
-- they're what the library list and search filter on.
create table public.conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  url text,
  platform text,
  status text not null default 'done',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index conversations_user_id_updated_at_idx
  on public.conversations (user_id, updated_at desc);

alter table public.conversations enable row level security;

create policy "conversations: select own" on public.conversations
  for select using (auth.uid() = user_id);

create policy "conversations: insert own" on public.conversations
  for insert with check (auth.uid() = user_id);

create policy "conversations: update own" on public.conversations
  for update using (auth.uid() = user_id);

create policy "conversations: delete own" on public.conversations
  for delete using (auth.uid() = user_id);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute procedure public.set_updated_at();

-- Neither trigger function needs to be callable directly through the API — only
-- Postgres itself invokes them, as triggers.
revoke execute on function public.handle_new_user() from anon, authenticated;
