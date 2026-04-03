-- Migration: Enable Supabase Realtime on the notes table.
--
-- REPLICA IDENTITY FULL instructs Postgres to write every column (not
-- just the primary key) into the WAL record for UPDATE and DELETE events.
-- Without this, the old record for a DELETE only contains the PK (id),
-- so Realtime's server-side filter `user_id=eq.X` cannot match on it
-- and cross-tab DELETE events would be silently dropped.
-- FULL is also required for UPDATE events to carry the full previous row.
alter table public.notes replica identity full;

-- Add the notes table to the supabase_realtime logical replication
-- publication. Tables must explicitly opt in — Realtime never receives
-- changes from tables that are not in this publication.
alter publication supabase_realtime add table public.notes;
