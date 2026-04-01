-- Migration: Enable RLS and add row-level security policies
-- Users can only read/write their own rows.

-- ============================================================
-- USERS TABLE
-- ============================================================
alter table public.users enable row level security;
-- Even table owners respect RLS at runtime.
alter table public.users force row level security;

-- Users can read their own profile row.
create policy "users: select own row"
  on public.users for select
  to authenticated
  using ((select auth.uid()) = id);

-- Users can update their own profile row.
create policy "users: update own row"
  on public.users for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- New users can insert their own profile row (e.g. after sign-up trigger).
create policy "users: insert own row"
  on public.users for insert
  to authenticated
  with check ((select auth.uid()) = id);

-- ============================================================
-- NOTES TABLE
-- ============================================================
alter table public.notes enable row level security;
alter table public.notes force row level security;

-- SELECT: users can only see their own notes.
-- Wrapping auth.uid() in a sub-SELECT caches the result for the
-- query instead of re-evaluating it per row (100x+ faster on large tables).
create policy "notes: select own"
  on public.notes for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- INSERT: users can only add notes owned by themselves.
create policy "notes: insert own"
  on public.notes for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- UPDATE: users can only update notes they own.
create policy "notes: update own"
  on public.notes for update
  to authenticated
  using  ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- DELETE: users can only delete their own notes.
create policy "notes: delete own"
  on public.notes for delete
  to authenticated
  using ((select auth.uid()) = user_id);
