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

-- ============================================================
-- TAGS
-- Batch insert for all users in one round-trip (data-batch-inserts).
-- ON CONFLICT DO NOTHING makes the seed idempotent on repeated db reset.
-- ============================================================
insert into public.tags (user_id, name, created_at) values
  -- Alice's tags
  ('a0000000-0000-0000-0000-000000000001', 'personal',  now() - interval '28 days'),
  ('a0000000-0000-0000-0000-000000000001', 'shopping',  now() - interval '28 days'),
  ('a0000000-0000-0000-0000-000000000001', 'work',      now() - interval '28 days'),
  -- Bob's tags
  ('b0000000-0000-0000-0000-000000000002', 'work',      now() - interval '18 days'),
  ('b0000000-0000-0000-0000-000000000002', 'books',     now() - interval '18 days'),
  -- Carol's tags
  ('c0000000-0000-0000-0000-000000000003', 'tasks',     now() - interval '9 days'),
  ('c0000000-0000-0000-0000-000000000003', 'postgres',  now() - interval '9 days')
on conflict on constraint tags_user_name_unique do nothing;

-- ============================================================
-- NOTE_TAGS
-- CTE resolves note IDs and tag IDs by name/title rather than
-- hard-coding IDENTITY values that change across db reset.
-- ============================================================
with note_ids as (
  select id, title, user_id from public.notes
),
tag_ids as (
  select id, name, user_id from public.tags
)
insert into public.note_tags (note_id, tag_id)
select n.id, t.id
from (values
  -- Alice: Welcome note → personal
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Welcome to Notes',    'personal'),
  -- Alice: Shopping List → shopping, personal
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Shopping List',       'shopping'),
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Shopping List',       'personal'),
  -- Alice: Project Ideas → work, personal
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Project Ideas',       'work'),
  ('a0000000-0000-0000-0000-000000000001'::uuid, 'Project Ideas',       'personal'),
  -- Bob: Meeting Notes → work
  ('b0000000-0000-0000-0000-000000000002'::uuid, 'Meeting Notes',       'work'),
  -- Bob: Book Recommendations → books
  ('b0000000-0000-0000-0000-000000000002'::uuid, 'Book Recommendations','books'),
  -- Carol: Today's Tasks → tasks
  ('c0000000-0000-0000-0000-000000000003'::uuid, 'Today''s Tasks',      'tasks'),
  -- Carol: Postgres Tips → postgres
  ('c0000000-0000-0000-0000-000000000003'::uuid, 'Postgres Tips',       'postgres')
) as mapping(u_id, note_title, tag_name)
join note_ids n on n.title = mapping.note_title and n.user_id = mapping.u_id
join tag_ids  t on t.name  = mapping.tag_name   and t.user_id = mapping.u_id
on conflict do nothing;
