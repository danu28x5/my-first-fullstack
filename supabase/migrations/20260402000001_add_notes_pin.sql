-- Migration: Add is_pinned column to notes
-- Pinned notes sort to the top of the list (ORDER BY is_pinned DESC).

alter table public.notes
  add column is_pinned boolean not null default false;

-- Composite index that satisfies:
--   SELECT * FROM notes WHERE user_id = $1 ORDER BY is_pinned DESC, created_at DESC
-- Placing equality column (user_id) first, then the two ORDER BY columns, lets
-- Postgres resolve both the filter and the sort in a single index scan with no
-- separate sort step (query-composite-indexes rule).
create index if not exists notes_user_pin_created_idx
  on public.notes (user_id, is_pinned desc, created_at desc);

-- The existing notes_user_id_idx is intentionally kept: it is still used by
-- ON DELETE CASCADE and any query that filters by user_id without ordering.
