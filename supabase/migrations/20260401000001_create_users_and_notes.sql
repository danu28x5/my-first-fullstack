-- Migration: Create users and notes tables
-- Users extend Supabase auth.users with a public profile table.
-- Notes belong to users (one-to-many).

-- ============================================================
-- USERS (profiles)
-- ============================================================
-- We reference auth.users so Supabase Auth manages credentials.
-- Use text for variable-length strings (no artificial varchar limit).
-- Use timestamptz so all timestamps are timezone-aware.
create table if not exists public.users (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text        not null,
  email        text        not null unique,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ============================================================
-- NOTES
-- ============================================================
-- bigint IDENTITY is SQL-standard and avoids UUIDv4 fragmentation
-- for a single-database setup.
create table if not exists public.notes (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.users (id) on delete cascade,
  title      text        not null,
  content    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
-- Index the FK column: Postgres does NOT create FK indexes automatically.
-- This makes JOINs and ON DELETE CASCADE fast (10-100x with large tables).
create index if not exists notes_user_id_idx on public.notes (user_id);

-- ============================================================
-- TRIGGER: keep updated_at current
-- ============================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

create or replace trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();
