-- Migration: Document sharing
-- Mirrors the note sharing pattern (20260406000001 + 20260406000002 + 0004/0005).
-- Allows a document owner to share a document with another user by email,
-- granting either view-only or edit access.
--
-- Reuses:
--   - public.share_permission enum (created in 20260406000001_note_sharing.sql)
--   - public.find_user_for_share(text) function (same migration)
-- Creates:
--   - public.document_shares table + indexes + Realtime
--   - public.auth_user_owns_document(bigint) security definer helper
--   - RLS policies on document_shares
--   - Additive SELECT/UPDATE policies on documents for shared access
--   - Replaces users + avatars policies to include document_shares counterparts

-- ============================================================
-- 1. document_shares table
-- ============================================================
-- bigint IDENTITY is SQL-standard, consistent with documents.id and
-- note_shares.id (schema-primary-keys rule).
-- Reuses existing share_permission enum (view | edit).
create table if not exists public.document_shares (
  id                  bigint                  generated always as identity primary key,
  document_id         bigint                  not null references public.documents (id) on delete cascade,
  owner_id            uuid                    not null references public.users     (id) on delete cascade,
  shared_with_user_id uuid                    not null references public.users     (id) on delete cascade,
  permission          public.share_permission not null default 'view',
  created_at          timestamptz             not null default now(),
  -- Prevent self-shares at the database level.
  constraint document_shares_no_self_share check (owner_id <> shared_with_user_id)
);

-- ============================================================
-- 2. Unique constraint: one share per (document, recipient)
-- ============================================================
-- Postgres does not support ADD CONSTRAINT IF NOT EXISTS, so we use a
-- DO block for idempotency (schema-constraints rule).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname  = 'document_shares_document_id_shared_with_user_id_key'
      and conrelid = 'public.document_shares'::regclass
  ) then
    alter table public.document_shares
      add constraint document_shares_document_id_shared_with_user_id_key
        unique (document_id, shared_with_user_id);
  end if;
end $$;

-- ============================================================
-- 3. Indexes on FK columns
-- ============================================================
-- Postgres does NOT create FK indexes automatically.
-- document_id:         used by ON DELETE CASCADE + EXISTS in RLS.
-- owner_id:            used by RLS policy evaluation + ON DELETE CASCADE.
-- shared_with_user_id: used by RLS policy evaluation + Realtime filter.
-- Covering index (shared_with_user_id, document_id): makes the EXISTS subquery
-- in the extended documents SELECT policy an index-only scan
-- (security-rls-performance rule).
create index if not exists document_shares_document_id_idx
  on public.document_shares (document_id);

create index if not exists document_shares_owner_id_idx
  on public.document_shares (owner_id);

create index if not exists document_shares_shared_with_user_id_idx
  on public.document_shares (shared_with_user_id);

create index if not exists document_shares_shared_with_doc_idx
  on public.document_shares (shared_with_user_id, document_id);

-- ============================================================
-- 4. Realtime opt-in
-- ============================================================
-- REPLICA IDENTITY FULL writes all columns into the WAL record for UPDATE
-- and DELETE events.  Without this, a DELETE event only carries the PK (id),
-- so Realtime's server-side filter `shared_with_user_id=eq.${userId}` cannot
-- match on delete and the event is silently dropped — same reason note_shares
-- has REPLICA IDENTITY FULL.
alter table public.document_shares replica identity full;

-- Add document_shares to the Supabase Realtime publication so the frontend
-- can subscribe to INSERT, UPDATE, and DELETE events on this table.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname    = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'document_shares'
  ) then
    alter publication supabase_realtime add table public.document_shares;
  end if;
end $$;

-- ============================================================
-- 5. Security definer helper: auth_user_owns_document(bigint)
-- ============================================================
-- Mirrors auth_user_owns_note(bigint) from 20260406000002.
-- Bypasses documents RLS to prevent the recursion cycle:
--   "document_shares: owner insert" → queries documents →
--   "documents: select shared" → queries document_shares → ∞
-- security definer + set search_path = '' (OWASP A03 prevention).
create or replace function public.auth_user_owns_document(p_document_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.documents
    where id      = p_document_id
      and user_id = (select auth.uid())
  );
$$;

revoke execute on function public.auth_user_owns_document(bigint) from public;
grant  execute on function public.auth_user_owns_document(bigint) to authenticated;

-- ============================================================
-- 6. Row Level Security on document_shares
-- ============================================================
alter table public.document_shares enable row level security;
alter table public.document_shares force row level security;

-- (select auth.uid()) — sub-SELECT wrapper so the value is evaluated once per
-- query, not once per row — 5-10x faster on large tables
-- (security-rls-performance rule).

-- Owner sees all share rows for documents they own.
create policy "document_shares: owner select"
  on public.document_shares for select
  to authenticated
  using ((select auth.uid()) = owner_id);

-- Recipient sees only their own share rows (not other recipients' rows).
create policy "document_shares: recipient select"
  on public.document_shares for select
  to authenticated
  using ((select auth.uid()) = shared_with_user_id);

-- Only the document owner may create a share, AND they must actually own that
-- document.  Uses the security definer helper to break the RLS recursion cycle.
create policy "document_shares: owner insert"
  on public.document_shares for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and public.auth_user_owns_document(document_id)
  );

-- Only the document owner may change the permission column.
-- Uses the security definer helper to break the RLS recursion cycle
-- (same fix as 20260406000005_fix_note_shares_update_rls.sql).
create policy "document_shares: owner update"
  on public.document_shares for update
  to authenticated
  using  ((select auth.uid()) = owner_id)
  with check (
    owner_id = (select auth.uid())
    and public.auth_user_owns_document(document_id)
  );

-- Only the document owner may revoke (delete) a share.
create policy "document_shares: owner delete"
  on public.document_shares for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

-- ============================================================
-- 7. Extend documents SELECT: shared users can read a document
-- ============================================================
-- Second permissive SELECT policy — Postgres ORs all permissive policies
-- together so this is purely additive.  The existing "documents: select own"
-- policy is untouched.
create policy "documents: select shared"
  on public.documents for select
  to authenticated
  using (
    exists (
      select 1 from public.document_shares
      where document_id         = documents.id
        and shared_with_user_id = (select auth.uid())
    )
  );

-- ============================================================
-- 8. Extend documents UPDATE: edit-permission shared users can
--    update content
-- ============================================================
-- Second permissive UPDATE policy — additive alongside "documents: update own".
-- `with check (user_id = documents.user_id)` prevents a shared editor from
-- reassigning document ownership.
-- Documents have no is_pinned / archived_at columns, so no immutable-column
-- guards are needed (simpler than the notes equivalent).
create policy "documents: update shared edit"
  on public.documents for update
  to authenticated
  using (
    exists (
      select 1 from public.document_shares
      where document_id         = documents.id
        and shared_with_user_id = (select auth.uid())
        and permission          = 'edit'
    )
  )
  with check (
    user_id = documents.user_id
  );

-- ============================================================
-- 9. Extend users SELECT: document share counterparts can read
--    each other's profile
-- ============================================================
-- Replace the existing policy (created in 20260406000001_note_sharing.sql)
-- with one that ORs both note_shares AND document_shares lookups.
-- A single combined policy is cleaner than two overlapping permissive policies.
drop policy if exists "users: share counterpart select" on public.users;

create policy "users: share counterpart select"
  on public.users for select
  to authenticated
  using (
    exists (
      select 1 from public.note_shares
      where (owner_id            = users.id and shared_with_user_id = (select auth.uid()))
         or (shared_with_user_id = users.id and owner_id            = (select auth.uid()))
    )
    or exists (
      select 1 from public.document_shares
      where (owner_id            = users.id and shared_with_user_id = (select auth.uid()))
         or (shared_with_user_id = users.id and owner_id            = (select auth.uid()))
    )
  );

-- ============================================================
-- 10. Extend avatars bucket: document-shared users can read the
--     document-owner's avatar
-- ============================================================
-- Replace the existing policy (created in 20260406000001_note_sharing.sql)
-- with one that ORs both note_shares AND document_shares lookups.
-- Path convention: {owner_user_id}/avatar.{ext}
-- storage.foldername(name)[1] = owner_user_id (text, 1-based Postgres array).
drop policy if exists "avatars: shared read" on storage.objects;

create policy "avatars: shared read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (
      exists (
        select 1 from public.note_shares
        where owner_id            = (storage.foldername(name))[1]::uuid
          and shared_with_user_id = (select auth.uid())
      )
      or exists (
        select 1 from public.document_shares
        where owner_id            = (storage.foldername(name))[1]::uuid
          and shared_with_user_id = (select auth.uid())
      )
    )
  );
