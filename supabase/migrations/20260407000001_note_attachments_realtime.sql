-- Migration: Enable Supabase Realtime on the note_attachments table.
--
-- REPLICA IDENTITY FULL instructs Postgres to write every column into the WAL
-- record for DELETE events. Without this, a DELETE record only contains the PK
-- (id), so Realtime's server-side filter `user_id=eq.X` cannot match on it and
-- cross-tab DELETE events would be silently dropped — the same reason
-- 20260403000002_notes_realtime.sql applies FULL to the notes table.
-- FULL is also used for UPDATE events though note_attachments are immutable
-- (write-once by policy), so only INSERT and DELETE are relevant in practice.
alter table public.note_attachments replica identity full;

-- Add note_attachments to the supabase_realtime logical replication
-- publication. Tables must explicitly opt in — Realtime never receives
-- changes from tables that are not in this publication.
alter publication supabase_realtime add table public.note_attachments;
