-- Migration: Allow note owner to update permission on an existing share row.
-- This unlocks in-place permission changes (view ↔ edit) so the share row
-- does not need to be deleted and re-inserted — avoiding the flash/reorder
-- the recipient would otherwise see in the "Shared with me" tab.

-- ============================================================
-- 1. RLS UPDATE policy on note_shares
-- ============================================================
-- Only the note owner may change the permission column.
-- The with check mirrors the insert policy: owner_id must stay the caller,
-- and the note must still belong to them (prevents moves across notes).
-- Shared editors cannot change their own permission level.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_shares'
      and policyname = 'note_shares: owner update'
  ) then
    create policy "note_shares: owner update"
      on public.note_shares for update
      to authenticated
      using  ((select auth.uid()) = owner_id)
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
