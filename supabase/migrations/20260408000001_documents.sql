-- Migration: Create documents table
-- Documents are long-form Markdown content belonging to a user.
-- Follows the same patterns as notes (migration 0001 + 0002 + realtime).

-- ============================================================
-- DOCUMENTS
-- ============================================================
-- bigint IDENTITY is SQL-standard and avoids UUIDv4 fragmentation
-- for a single-database setup (schema-primary-keys rule).
-- text for title and body — no artificial varchar limit, same performance
-- (schema-data-types rule). Postgres TOAST handles large body values
-- automatically (compressed, up to ~1 GB).
-- timestamptz for all timestamps — always timezone-aware.
create table if not exists public.documents (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.users (id) on delete cascade,
  title      text        not null,
  body       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
-- Index the FK column: Postgres does NOT create FK indexes automatically.
-- This makes JOINs and ON DELETE CASCADE fast (10-100x with large tables)
-- (schema-foreign-key-indexes rule).
create index if not exists documents_user_id_idx on public.documents (user_id);

-- ============================================================
-- TRIGGER: keep updated_at current
-- ============================================================
-- Reuses the set_updated_at() function created in migration 0001.
-- Every UPDATE automatically gets a fresh timestamp — no app-side
-- management needed, and no code path can forget.
create or replace trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- Same owner-only pattern as notes (migration 0002).
-- (select auth.uid()) caches the result per query, not per row — 100x+
-- faster on large tables (security-rls-performance rule).
alter table public.documents enable row level security;
alter table public.documents force row level security;

create policy "documents: select own"
  on public.documents for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "documents: insert own"
  on public.documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "documents: update own"
  on public.documents for update
  to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "documents: delete own"
  on public.documents for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- REALTIME
-- ============================================================
-- REPLICA IDENTITY FULL instructs Postgres to write every column into the
-- WAL record for UPDATE and DELETE events. Without this, DELETE payloads
-- only contain the PK and Realtime's server-side filter on user_id cannot
-- match — events would be silently dropped.
alter table public.documents replica identity full;

-- Add to the supabase_realtime publication so Realtime receives changes.
alter publication supabase_realtime add table public.documents;
