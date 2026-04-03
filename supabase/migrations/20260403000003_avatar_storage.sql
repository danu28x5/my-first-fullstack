-- Migration: Add avatar_path column and create private avatars storage bucket
-- Avatars are stored in a private bucket; signed URLs are generated at display
-- time and never persisted to the database.

-- ============================================================
-- 1. Add avatar_path column to public.users
-- ============================================================
-- text (not varchar) — no artificial length limit (schema-data-types rule).
-- Nullable — NULL means the user has not uploaded an avatar yet.
alter table public.users add column if not exists avatar_path text;

-- ============================================================
-- 2. Create the private avatars bucket
-- ============================================================
-- public = false → all reads require a signed URL via createSignedUrl().
-- file_size_limit = 2097152 bytes (2 MiB) — server-side enforcement to
-- complement the client-side validation in the upload component.
-- allowed_mime_types restricts uploads to common image formats.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

-- ============================================================
-- 3. RLS policies on storage.objects for the avatars bucket
-- ============================================================
-- Path convention: {user_id}/avatar.png
-- storage.foldername(name)[1] extracts the first path segment (1-based arrays
-- in Postgres). This is the idiomatic Supabase owner-only pattern: the folder
-- name equals the uploader's user ID, which is verified on INSERT (WITH CHECK)
-- to prevent ownership spoofing, and on SELECT/UPDATE/DELETE (USING) for all
-- subsequent access.
--
-- Each policy is wrapped in a DO block for idempotency — Postgres does not
-- support CREATE POLICY IF NOT EXISTS (schema-constraints rule).

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'avatars: owner read'
  ) then
    create policy "avatars: owner read"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'avatars: owner insert'
  ) then
    create policy "avatars: owner insert"
      on storage.objects for insert
      to authenticated
      with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'avatars: owner update'
  ) then
    create policy "avatars: owner update"
      on storage.objects for update
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (auth.uid())::text
      );
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'avatars: owner delete'
  ) then
    create policy "avatars: owner delete"
      on storage.objects for delete
      to authenticated
      using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = (auth.uid())::text
      );
  end if;
end $$;
