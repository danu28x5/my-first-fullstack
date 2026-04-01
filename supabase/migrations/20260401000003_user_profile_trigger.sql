-- Migration: Auto-create public.users profile via trigger on auth.users
--
-- Why: Client-side profile inserts fail when email confirmation is enabled
-- (the session doesn't exist yet so auth.uid() is null, breaking the RLS
-- with check policy on public.users). A SECURITY DEFINER trigger runs as
-- the postgres role, bypasses RLS entirely, and works regardless of whether
-- email confirmation is on or off.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Fire after every new auth user is inserted
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
