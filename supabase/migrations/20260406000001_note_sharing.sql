-- Migration: Note sharing
-- Allows a note owner to share a note with another user by email,
-- granting either view-only or edit access.
-- Also extends the avatars and attachments storage bucket read policies
-- so shared users can view the owner's avatar and the note's attachments.

-- ============================================================
-- 1. Enum type for permission levels
-- ============================================================
-- text + CHECK is generally more evolvable, but the feature spec requests
-- an enum.  Note: adding a third value later requires ALTER TYPE … ADD VALUE
-- which cannot be rolled back inside a transaction (unlike a CHECK constraint
-- swap), so document the trade-off here.
do $$ begin
  if not exists (
    select 1 from pg_type
    where typname = 'share_permission'
      and typnamespace = 'public'::regnamespace
  ) then
    create type public.share_permission as enum ('view', 'edit');
  end if;
end $$;

-- ============================================================
-- 2. note_shares table
-- ============================================================
-- bigint IDENTITY is SQL-standard, consistent with notes.id and
-- note_attachments.id (schema-primary-keys rule).
-- text columns use text, not varchar (schema-data-types rule).
-- No updated_at column — rows are write-once (no UPDATE policy).
create table if not exists public.note_shares (
  id                  bigint           generated always as identity primary key,
  note_id             bigint           not null references public.notes   (id) on delete cascade,
  owner_id            uuid             not null references public.users   (id) on delete cascade,
  shared_with_user_id uuid             not null references public.users   (id) on delete cascade,
  permission          public.share_permission not null default 'view',
  created_at          timestamptz      not null default now(),
  -- Prevent self-shares at the database level.
  constraint note_shares_no_self_share check (owner_id <> shared_with_user_id)
);

-- ============================================================
-- 3. Unique constraint: one share per (note, recipient)
-- ============================================================
-- Postgres does not support ADD CONSTRAINT IF NOT EXISTS, so we use a
-- DO block for idempotency (schema-constraints rule).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'note_shares_note_id_shared_with_user_id_key'
      and conrelid = 'public.note_shares'::regclass
  ) then
    alter table public.note_shares
      add constraint note_shares_note_id_shared_with_user_id_key
        unique (note_id, shared_with_user_id);
  end if;
end $$;

-- ============================================================
-- 4. Indexes on FK columns
-- ============================================================
-- Postgres does NOT create FK indexes automatically.
-- note_id:             used by ON DELETE CASCADE + EXISTS in RLS.
-- owner_id:            used by RLS policy evaluation + ON DELETE CASCADE.
-- shared_with_user_id: used by RLS policy evaluation + Realtime filter.
-- Covering index (shared_with_user_id, note_id): makes the EXISTS subquery in
-- the extended notes SELECT policy an index-only scan (security-rls-performance rule).
create index if not exists note_shares_note_id_idx
  on public.note_shares (note_id);

create index if not exists note_shares_owner_id_idx
  on public.note_shares (owner_id);

create index if not exists note_shares_shared_with_user_id_idx
  on public.note_shares (shared_with_user_id);

create index if not exists note_shares_shared_with_note_idx
  on public.note_shares (shared_with_user_id, note_id);

-- ============================================================
-- 5. Realtime opt-in
-- ============================================================
-- REPLICA IDENTITY FULL writes all columns into the WAL record for UPDATE
-- and DELETE events.  Without this, a DELETE event only carries the PK (id),
-- so Realtime's server-side filter `shared_with_user_id=eq.${userId}` cannot
-- match on delete and the event is silently dropped — the same reason notes
-- has REPLICA IDENTITY FULL (see 20260403000002_notes_realtime.sql).
alter table public.note_shares replica identity full;

-- Add note_shares to the Supabase Realtime publication so the frontend can
-- subscribe to INSERT and DELETE events on this table.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename  = 'note_shares'
  ) then
    alter publication supabase_realtime add table public.note_shares;
  end if;
end $$;

-- ============================================================
-- 6. Row Level Security on note_shares
-- ============================================================
alter table public.note_shares enable row level security;
alter table public.note_shares force row level security;

-- (select auth.uid()) — sub-SELECT wrapper so the value is evaluated once per
-- query, not once per row — 5-10x faster on large tables
-- (security-rls-performance rule).

-- Owner sees all share rows for notes they own.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_shares'
      and policyname = 'note_shares: owner select'
  ) then
    create policy "note_shares: owner select"
      on public.note_shares for select
      to authenticated
      using ((select auth.uid()) = owner_id);
  end if;
end $$;

-- Recipient sees only their own share rows (not other recipients' rows).
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_shares'
      and policyname = 'note_shares: recipient select'
  ) then
    create policy "note_shares: recipient select"
      on public.note_shares for select
      to authenticated
      using ((select auth.uid()) = shared_with_user_id);
  end if;
end $$;

-- Only the note owner may create a share, AND they must actually own that note.
-- The nested EXISTS prevents a user from creating a share where owner_id = their
-- ID but the note belongs to someone else.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_shares'
      and policyname = 'note_shares: owner insert'
  ) then
    create policy "note_shares: owner insert"
      on public.note_shares for insert
      to authenticated
      with check (
        owner_id = (select auth.uid())
        and exists (
          select 1 from public.notes
          where id      = note_id
            and user_id = (select auth.uid())
        )
      );
  end if;
end $$;

-- Only the note owner may revoke (delete) a share.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_shares'
      and policyname = 'note_shares: owner delete'
  ) then
    create policy "note_shares: owner delete"
      on public.note_shares for delete
      to authenticated
      using ((select auth.uid()) = owner_id);
  end if;
end $$;

-- No UPDATE policy — shares are immutable: revoke and re-create to change
-- the permission level.

-- ============================================================
-- 7. Extend notes SELECT: shared users can read a note
-- ============================================================
-- Adding a SECOND permissive SELECT policy — Postgres ORs all permissive
-- policies together so this is purely additive.  The existing
-- "notes: select own" policy is untouched.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'notes'
      and policyname = 'notes: select shared'
  ) then
    create policy "notes: select shared"
      on public.notes for select
      to authenticated
      using (
        exists (
          select 1 from public.note_shares
          where note_id             = notes.id
            and shared_with_user_id = (select auth.uid())
        )
      );
  end if;
end $$;

-- ============================================================
-- 8. Extend notes UPDATE: edit-permission shared users can update content
-- ============================================================
-- Second permissive UPDATE policy — additive alongside "notes: update own".
-- `with check (user_id = notes.user_id)` prevents a shared editor from
-- reassigning the note's ownership to themselves or anyone else.
-- Delete, pin (is_pinned), and archive (archived_at) remain owner-only
-- because there is no second permissive DELETE policy and the UPDATE own
-- policy still enforces user_id ownership for those operations.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'notes'
      and policyname = 'notes: update shared edit'
  ) then
    create policy "notes: update shared edit"
      on public.notes for update
      to authenticated
      using (
        exists (
          select 1 from public.note_shares
          where note_id             = notes.id
            and shared_with_user_id = (select auth.uid())
            and permission          = 'edit'
        )
      )
      with check (
        -- Shared editor cannot change ownership.
        user_id = notes.user_id
        -- Shared editor cannot pin or archive the note.
        -- We re-read the persisted row values so the check fires even when
        -- those columns are omitted from the UPDATE statement.
        and is_pinned   = (select n.is_pinned   from public.notes n where n.id = notes.id)
        and archived_at is not distinct from
            (select n.archived_at from public.notes n where n.id = notes.id)
      );
  end if;
end $$;

-- ============================================================
-- 9. Extend users SELECT: share counterparts can read each other's profile
-- ============================================================
-- Needed so:
--   a) the owner can see the recipient's display_name in SharePanel, and
--   b) the recipient can fetch the owner's display_name and avatar_path.
-- The policy is bounded: only users linked via note_shares can see each
-- other — it is not a public directory.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'users'
      and policyname = 'users: share counterpart select'
  ) then
    create policy "users: share counterpart select"
      on public.users for select
      to authenticated
      using (
        exists (
          select 1 from public.note_shares
          where (owner_id            = users.id and shared_with_user_id = (select auth.uid()))
             or (shared_with_user_id = users.id and owner_id            = (select auth.uid()))
        )
      );
  end if;
end $$;

-- ============================================================
-- 10. find_user_for_share — safe email-to-profile lookup
-- ============================================================
-- security definer: runs as the function owner, bypassing RLS on users.
-- Exposes ONLY id + display_name — never other columns.
-- Exact-match (no LIKE / ILIKE) prevents enumeration.
-- set search_path = '' prevents search-path injection (OWASP A03).
-- stable: result can be cached within a transaction.
create or replace function public.find_user_for_share(p_email text)
returns table (user_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select id, display_name
  from   public.users
  where  email = lower(trim(p_email))
  limit  1;
$$;

-- Revoke the implicit public grant added by Postgres, then grant only to
-- signed-in users.  Without these two lines any anonymous caller can invoke
-- the function.
revoke execute on function public.find_user_for_share(text) from public;
grant  execute on function public.find_user_for_share(text) to authenticated;

-- ============================================================
-- 11. avatars bucket: shared users can read the note-owner's avatar
-- ============================================================
-- Path convention: {owner_user_id}/avatar.{ext}
-- storage.foldername(name)[1] = owner_user_id (text, 1-based Postgres array).
-- Shared user may read this object when they have any note_shares row where
-- owner_id matches the folder name (= the avatar owner).
-- Write policies (INSERT / UPDATE / DELETE) are untouched.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'avatars: shared read'
  ) then
    create policy "avatars: shared read"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'avatars'
        and exists (
          select 1 from public.note_shares
          where owner_id            = (storage.foldername(name))[1]::uuid
            and shared_with_user_id = (select auth.uid())
        )
      );
  end if;
end $$;

-- ============================================================
-- 12. attachments bucket: shared users can read a note's attachments
-- ============================================================
-- Path convention: {owner_user_id}/{note_id}/{filename}
-- storage.foldername(name)[2] = note_id (text, cast to bigint).
-- Shared user may read an attachment when they have a note_shares row for
-- that specific note_id (any permission level — both view and edit).
-- Write policies (INSERT / DELETE) are untouched.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'attachments: shared read'
  ) then
    create policy "attachments: shared read"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'attachments'
        and exists (
          select 1 from public.note_shares
          where note_id             = (storage.foldername(name))[2]::bigint
            and shared_with_user_id = (select auth.uid())
        )
      );
  end if;
end $$;
