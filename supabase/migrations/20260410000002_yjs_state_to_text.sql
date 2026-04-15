-- Migration: Change yjs_state from bytea to text
--
-- PostgREST serialises bytea columns as hex-encoded strings (\x…) in JSON
-- responses, and expects hex input on writes.  The frontend encodes Yjs
-- state as base64 — a plain text format.  Storing base64 in a bytea column
-- causes a double-encoding mismatch:
--
--   Write: base64 string → stored as ASCII bytes of the base64 chars (wrong)
--   Read:  hex of those ASCII bytes → fromBase64('\x41…') → atob throws
--
-- Switching to text eliminates the mismatch entirely — PostgREST passes
-- text columns as-is in JSON, so the base64 round-trip is lossless.
--
-- Any existing yjs_state data from the bytea era is corrupted and must be
-- cleared.  Users will simply re-seed from the plain-text body column on
-- next edit (the same migration path used for pre-existing documents).

-- Drop and re-add to avoid bytea→text casting issues with corrupted data.
alter table public.documents drop column if exists yjs_state;
alter table public.documents add column yjs_state text;
