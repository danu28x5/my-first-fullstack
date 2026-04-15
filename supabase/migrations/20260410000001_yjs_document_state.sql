-- Migration: Add yjs_state column to documents
-- Stores the encoded Yjs CRDT document state as opaque binary data.
-- Used to hydrate new clients joining a collaborative editing session
-- and as a durable snapshot when all clients disconnect.
--
-- bytea is the correct Postgres type for opaque binary. TOAST handles
-- automatic compression and out-of-line storage — typical Yjs state
-- (10 KB – 1 MB) is well within limits (schema-data-types rule).
--
-- No index needed — this column is only read/written by PK lookup,
-- never filtered or sorted.
--
-- The existing plain-text `body` column is retained alongside yjs_state
-- for full-text search, list previews, non-Yjs consumers, and debugging.
-- Both are written atomically in a single UPDATE.

alter table public.documents
  add column if not exists yjs_state bytea;
