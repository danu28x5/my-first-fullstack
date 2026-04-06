-- Migration: Fix infinite recursion in note_shares and notes RLS policies
--
-- Root cause:
--   Cycle 1 — "note_shares: owner insert" with check queries public.notes,
--   which triggers "notes: select shared", which queries public.note_shares
--   — the table currently being evaluated → infinite recursion.
--
--   Cycle 2 — "notes: update shared edit" with check contains sub-selects
--   that query public.notes from inside a public.notes policy → infinite
--   recursion on notes itself.
--
-- Fix: security definer helper functions bypass RLS on their target tables,
-- breaking both cycles (security-rls-performance rule).

-- ============================================================
-- 1. Helper: check note ownership (bypasses notes RLS)
-- ============================================================
create or replace function public.auth_user_owns_note(p_note_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.notes
    where id      = p_note_id
      and user_id = (select auth.uid())
  );
$$;

revoke execute on function public.auth_user_owns_note(bigint) from public;
grant  execute on function public.auth_user_owns_note(bigint) to authenticated;

-- ============================================================
-- 2. Helper: read immutable note columns (bypasses notes RLS)
-- ============================================================
create or replace function public.get_note_immutable_cols(p_note_id bigint)
returns table(is_pinned boolean, archived_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select is_pinned, archived_at
  from   public.notes
  where  id = p_note_id;
$$;

revoke execute on function public.get_note_immutable_cols(bigint) from public;
grant  execute on function public.get_note_immutable_cols(bigint) to authenticated;

-- ============================================================
-- 3. Fix "note_shares: owner insert" — use helper instead of
--    direct sub-select on public.notes
-- ============================================================
drop policy if exists "note_shares: owner insert" on public.note_shares;

create policy "note_shares: owner insert"
  on public.note_shares for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and public.auth_user_owns_note(note_id)
  );

-- ============================================================
-- 4. Fix "notes: update shared edit" — use helper for the
--    immutable-column checks instead of querying notes directly
-- ============================================================
drop policy if exists "notes: update shared edit" on public.notes;

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
    user_id = notes.user_id
    and is_pinned = (
      select p.is_pinned from public.get_note_immutable_cols(notes.id) p
    )
    and archived_at is not distinct from (
      select p.archived_at from public.get_note_immutable_cols(notes.id) p
    )
  );
