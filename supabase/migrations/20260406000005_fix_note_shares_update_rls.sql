-- Migration: Fix infinite recursion in note_shares UPDATE RLS policy
--
-- Root cause (same class as migration 20260406000002):
--   "note_shares: owner update" with check queries public.notes directly:
--     exists (select 1 from public.notes where id = note_id and user_id = ...)
--   This triggers "notes: select shared", which queries public.note_shares
--   — the table whose UPDATE policy is currently being evaluated → recursion.
--
-- Fix: replace the direct notes sub-select with public.auth_user_owns_note(),
-- the security definer helper introduced in 20260406000002 that bypasses
-- notes RLS (security-rls-performance rule).

drop policy if exists "note_shares: owner update" on public.note_shares;

create policy "note_shares: owner update"
  on public.note_shares for update
  to authenticated
  using  ((select auth.uid()) = owner_id)
  with check (
    owner_id = (select auth.uid())
    and public.auth_user_owns_note(note_id)
  );
