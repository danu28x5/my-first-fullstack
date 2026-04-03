-- Migration: Add tags and note_tags tables
-- Each user owns their own tags (one-to-many).
-- Notes and tags have a many-to-many relationship via note_tags.

-- ============================================================
-- TAGS
-- ============================================================
-- bigint IDENTITY avoids UUIDv4 fragmentation for a small lookup table.
-- text, not varchar(n) — no artificial length limit (schema-data-types).
-- UNIQUE(user_id, name) creates an implicit composite index that covers
-- both "list all tags for a user" (leading user_id) and "find tag by name"
-- (full composite key) — avoids a redundant extra index (query-composite-indexes).
create table if not exists public.tags (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.users (id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),
  constraint tags_user_name_unique unique (user_id, name)
);

-- ============================================================
-- NOTE_TAGS  (join table)
-- ============================================================
-- Composite PK (note_id, tag_id) serves double duty:
--   • Enforces uniqueness (a tag can only appear once per note).
--   • Acts as an index with note_id as the leading column, so
--     "get all tags for a note" is an index scan — no extra index needed.
-- Postgres does NOT auto-create indexes for FK columns, so we must
-- explicitly index tag_id for:
--   • "get all notes for a tag" queries
--   • ON DELETE CASCADE from tags (otherwise a full table scan) (schema-foreign-key-indexes)
create table if not exists public.note_tags (
  note_id bigint not null references public.notes (id) on delete cascade,
  tag_id  bigint not null references public.tags  (id) on delete cascade,
  primary key (note_id, tag_id)
);

create index if not exists note_tags_tag_id_idx
  on public.note_tags (tag_id);

-- ============================================================
-- ROW LEVEL SECURITY — tags
-- ============================================================
alter table public.tags enable row level security;
alter table public.tags force row level security;

-- Wrapping auth.uid() in a sub-SELECT caches the result for the query,
-- not per-row — 100x+ faster on large tables (security-rls-performance).
create policy "tags: select own"
  on public.tags for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "tags: insert own"
  on public.tags for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tags: update own"
  on public.tags for update
  to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "tags: delete own"
  on public.tags for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- ROW LEVEL SECURITY — note_tags
-- ============================================================
alter table public.note_tags enable row level security;
alter table public.note_tags force row level security;

-- Ownership is anchored through the notes table.
-- The EXISTS subquery uses the existing notes_user_id_idx (from migration 0001)
-- so the lookup is an index scan, not a sequential scan.
-- (select auth.uid()) is cached for the whole query (security-rls-performance).
create policy "note_tags: select own"
  on public.note_tags for select
  to authenticated
  using (
    exists (
      select 1 from public.notes
      where notes.id = note_id
        and notes.user_id = (select auth.uid())
    )
  );

create policy "note_tags: insert own"
  on public.note_tags for insert
  to authenticated
  with check (
    exists (
      select 1 from public.notes
      where notes.id = note_id
        and notes.user_id = (select auth.uid())
    )
  );

-- No UPDATE policy — join-table rows are inserted or deleted, never mutated.

create policy "note_tags: delete own"
  on public.note_tags for delete
  to authenticated
  using (
    exists (
      select 1 from public.notes
      where notes.id = note_id
        and notes.user_id = (select auth.uid())
    )
  );
