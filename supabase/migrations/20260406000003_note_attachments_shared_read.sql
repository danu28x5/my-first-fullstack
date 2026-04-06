-- Migration: Allow shared users to read note_attachments metadata rows
--
-- The note_attachments table previously had only an "owner read" SELECT policy,
-- so shared users' join queries (e.g. notes(*, note_attachments(*))) returned
-- an empty array even though the storage bucket "attachments: shared read"
-- policy already permitted reading the objects.
--
-- No recursion risk: this policy queries public.note_shares, and note_shares
-- RLS policies do not query note_attachments in return.
--
-- (select auth.uid()) sub-SELECT wrapper — evaluated once per query, not once
-- per row (security-rls-performance rule).

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'note_attachments'
      and policyname = 'note_attachments: shared read'
  ) then
    create policy "note_attachments: shared read"
      on public.note_attachments for select
      to authenticated
      using (
        exists (
          select 1 from public.note_shares
          where note_id             = note_attachments.note_id
            and shared_with_user_id = (select auth.uid())
        )
      );
  end if;
end $$;
