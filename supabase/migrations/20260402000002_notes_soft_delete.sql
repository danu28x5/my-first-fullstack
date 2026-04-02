-- Migration: Soft delete (archive) for notes
-- archived_at IS NULL       → active note
-- archived_at IS NOT NULL   → archived note
-- No RLS changes needed: archiving is just an UPDATE, and the existing
-- "notes: update own" policy already covers writes to any column.

alter table public.notes
  add column archived_at timestamptz default null;

-- ── Indexes ──────────────────────────────────────────────────────────────

-- Active-notes index: replaces the previous full composite index.
-- Partial index only covers non-archived rows — 5-20x smaller than a full
-- index and used automatically when the query includes WHERE archived_at IS NULL
-- (query-partial-indexes rule).
drop index if exists notes_user_pin_created_idx;

create index if not exists notes_active_user_pin_created_idx
  on public.notes (user_id, is_pinned desc, created_at desc)
  where archived_at is null;

-- Archived-notes index: used by the archive view query
-- (WHERE user_id = $1 AND archived_at IS NOT NULL ORDER BY archived_at DESC).
create index if not exists notes_archived_user_idx
  on public.notes (user_id, archived_at desc)
  where archived_at is not null;
