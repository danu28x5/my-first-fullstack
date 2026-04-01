-- seed.sql — local development seed data for the notes app
-- Applied automatically by: supabase db reset
--
-- supabase db reset runs as the postgres superuser, which bypasses RLS even
-- when FORCE ROW LEVEL SECURITY is set on the tables. No role switch needed.
--
-- All test accounts share the password: password123

-- ============================================================
-- AUTH USERS
-- Inserting directly into auth.users lets the seed work without
-- going through the GoTrue HTTP API.
-- pgcrypto (pre-enabled in Supabase local dev) provides crypt/gen_salt.
-- ============================================================
insert into auth.users (
  id,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  aud,
  role
) values
  (
    'a0000000-0000-0000-0000-000000000001',
    'alice@example.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now() - interval '30 days',
    now() - interval '30 days',
    'authenticated',
    'authenticated'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'bob@example.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now() - interval '20 days',
    now() - interval '20 days',
    'authenticated',
    'authenticated'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'carol@example.com',
    crypt('password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now() - interval '10 days',
    now() - interval '10 days',
    'authenticated',
    'authenticated'
  )
on conflict (id) do nothing;

-- ============================================================
-- PUBLIC USERS (profiles)
-- Must be inserted after auth.users due to the FK reference.
-- Batch insert: one round-trip for all rows.
-- ============================================================
insert into public.users (id, display_name, email, created_at, updated_at) values
  (
    'a0000000-0000-0000-0000-000000000001',
    'Alice',
    'alice@example.com',
    now() - interval '30 days',
    now() - interval '30 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Bob',
    'bob@example.com',
    now() - interval '20 days',
    now() - interval '20 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Carol',
    'carol@example.com',
    now() - interval '10 days',
    now() - interval '10 days'
  )
on conflict (id) do nothing;

-- ============================================================
-- NOTES
-- Single batch INSERT for all rows (one round-trip, 10-50x faster
-- than individual inserts per the batch-inserts guideline).
-- id is omitted — the IDENTITY column assigns it automatically.
-- ============================================================
insert into public.notes (user_id, title, content, created_at, updated_at) values

  -- Alice's notes
  (
    'a0000000-0000-0000-0000-000000000001',
    'Welcome to Notes',
    'This is my first note. A great place to stay organised!',
    now() - interval '29 days',
    now() - interval '29 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Shopping List',
    E'- Milk\n- Eggs\n- Bread\n- Coffee',
    now() - interval '25 days',
    now() - interval '25 days'
  ),
  (
    'a0000000-0000-0000-0000-000000000001',
    'Project Ideas',
    E'1. Build a notes app\n2. Add tags and search\n3. Sync across devices',
    now() - interval '20 days',
    now() - interval '10 days'
  ),

  -- Bob's notes
  (
    'b0000000-0000-0000-0000-000000000002',
    'Meeting Notes',
    E'Attendees: Alice, Bob, Carol\n\nAction items:\n- Alice: design mockups\n- Bob: set up database\n- Carol: write tests',
    now() - interval '18 days',
    now() - interval '18 days'
  ),
  (
    'b0000000-0000-0000-0000-000000000002',
    'Book Recommendations',
    E'- The Pragmatic Programmer\n- Clean Code\n- Designing Data-Intensive Applications',
    now() - interval '15 days',
    now() - interval '15 days'
  ),

  -- Carol's notes
  (
    'c0000000-0000-0000-0000-000000000003',
    'Today''s Tasks',
    E'- [x] Set up Supabase project\n- [ ] Build frontend\n- [ ] Write seed data',
    now() - interval '9 days',
    now() - interval '5 days'
  ),
  (
    'c0000000-0000-0000-0000-000000000003',
    'Postgres Tips',
    E'Use timestamptz, not timestamp.\nIndex your foreign key columns.\nWrap auth.uid() in a sub-select for RLS policies.',
    now() - interval '7 days',
    now() - interval '7 days'
  );
