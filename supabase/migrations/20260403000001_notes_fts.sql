-- Migration: Full-text search for notes
-- Adds a stored tsvector generated column combining title (weight A) and
-- content (weight B), and a GIN index for fast @@ operator lookups.
--
-- GENERATED ALWAYS AS ... STORED: Postgres automatically maintains the column
-- on every INSERT/UPDATE — no trigger needed.
-- coalesce(content, ''): content is nullable; to_tsvector(null) = null which
-- would zero the whole expression.
-- setweight('A'/'B'): title matches rank above body matches via ts_rank.

alter table public.notes
  add column fts tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title,   '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored;

-- GIN is the required index type for the @@ (text search match) operator.
-- B-tree cannot serve @@ — using GIN gives 10-100x speedup over a seq scan.
-- Non-partial: covers both active and archived note searches without a second
-- index (query-index-types rule).
create index if not exists notes_fts_idx
  on public.notes
  using gin (fts);
