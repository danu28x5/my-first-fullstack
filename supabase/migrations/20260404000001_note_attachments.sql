-- Migration: Create note_attachments metadata table and private attachments bucket
-- Attachments are stored in a private bucket; signed URLs are generated at
-- display time and never persisted to the database.
-- Attachments are immutable once uploaded — there is no UPDATE policy on
-- either the table or the storage bucket.  Replace = delete + re-upload.

-- ============================================================
-- 1. note_attachments metadata table
-- ============================================================
-- bigint IDENTITY is SQL-standard, consistent with notes.id, and avoids
-- UUIDv4 write fragmentation for a single-database setup (schema-primary-keys).
-- text (not varchar) — no artificial length limit (schema-data-types rule).
-- byte_size is bigint, not int — files can exceed 2 GB.
-- No updated_at column — rows are write-once; the absence of an UPDATE
-- policy enforces this at the database level.
create table if not exists public.note_attachments (
  id           bigint      generated always as identity primary key,
  note_id      bigint      not null references public.notes (id) on delete cascade,
  user_id      uuid        not null references public.users (id) on delete cascade,
  storage_path text        not null,
  file_name    text        not null,
  mime_type    text        not null,
  byte_size    bigint      not null,
  created_at   timestamptz not null default now()
);

-- ============================================================
-- 2. Unique constraint on storage_path
-- ============================================================
-- Prevents the same storage object from being referenced twice.
-- Postgres does not support ADD CONSTRAINT IF NOT EXISTS, so we use a
-- DO block for idempotency (schema-constraints rule).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'note_attachments_storage_path_unique'
      and conrelid = 'public.note_attachments'::regclass
  ) then
    alter table public.note_attachments
      add constraint note_attachments_storage_path_unique unique (storage_path);
  end if;
end $$;

-- ============================================================
-- 3. Indexes on FK columns
-- ============================================================
-- Postgres does NOT create indexes on FK columns automatically.
-- note_id: used by fetching attachments for a note and ON DELETE CASCADE.
-- user_id: used by RLS policy evaluation and ON DELETE CASCADE.
-- (schema-foreign-key-indexes rule: missing FK indexes cause 10-100x slower
-- JOINs and cascade operations.)
create index if not exists note_attachments_note_id_idx on public.note_attachments (note_id);
create index if not exists note_attachments_user_id_idx on public.note_attachments (user_id);

-- ============================================================
-- 4. Row Level Security on note_attachments
-- ============================================================
alter table public.note_attachments enable row level security;

-- Wrap auth.uid() in a subquery so it is evaluated once and cached for the
-- entire statement rather than once per row — 5-10x faster on large tables
-- (security-rls-performance rule).

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_attachments'
      and policyname = 'note_attachments: owner read'
  ) then
    create policy "note_attachments: owner read"
      on public.note_attachments for select
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_attachments'
      and policyname = 'note_attachments: owner insert'
  ) then
    create policy "note_attachments: owner insert"
      on public.note_attachments for insert
      to authenticated
      with check ((select auth.uid()) = user_id);
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_attachments'
      and policyname = 'note_attachments: owner delete'
  ) then
    create policy "note_attachments: owner delete"
      on public.note_attachments for delete
      to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

-- ============================================================
-- 5. Create the private attachments bucket
-- ============================================================
-- public = false → all reads require a signed URL via createSignedUrl().
-- file_size_limit = 10485760 bytes (10 MiB) — server-side enforcement to
-- complement the client-side validation in the upload component.
-- allowed_mime_types restricts uploads to images and PDFs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments',
  'attachments',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do nothing;

-- ============================================================
-- 6. RLS policies on storage.objects for the attachments bucket
-- ============================================================
-- Path convention: {user_id}/{note_id}/{filename}
-- storage.foldername(name)[1] extracts the first path segment (1-based arrays
-- in Postgres). This is the idiomatic Supabase owner-only pattern: the folder
-- name equals the uploader's user ID, which is verified on INSERT (WITH CHECK)
-- to prevent ownership spoofing, and on SELECT/DELETE (USING) for all
-- subsequent access.
--
-- (select auth.uid()) — subquery wrapper evaluated once per query, not once
-- per row, for maximum RLS performance (security-rls-performance rule).
--
-- No UPDATE policy — attachments are immutable; replace = delete + re-upload.
--
-- Each policy is wrapped in a DO block for idempotency — Postgres does not
-- support CREATE POLICY IF NOT EXISTS (schema-constraints rule).

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'attachments: owner read'
  ) then
    create policy "attachments: owner read"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'attachments: owner insert'
  ) then
    create policy "attachments: owner insert"
      on storage.objects for insert
      to authenticated
      with check (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'attachments: owner delete'
  ) then
    create policy "attachments: owner delete"
      on storage.objects for delete
      to authenticated
      using (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end $$;
