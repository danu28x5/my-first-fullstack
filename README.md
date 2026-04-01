# my-first-fullstack

A full-stack notes app. Users sign up, sign in, and manage their own private notes. Each user's data is isolated at the database level using Postgres Row-Level Security — no server-side filtering logic required.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite |
| Backend / Auth | Supabase (Postgres + GoTrue Auth) |
| Database | Postgres 17 (via Supabase local dev) |
| Styling | Plain CSS with custom properties |

## Folder structure

```
my-first-fullstack/
├── frontend/                  # Vite + React SPA
│   ├── src/
│   │   ├── lib/
│   │   │   └── supabase.ts    # Typed Supabase client singleton
│   │   ├── components/
│   │   │   ├── AuthForm.jsx   # Sign-in / sign-up form
│   │   │   ├── NoteCard.jsx   # Single note display
│   │   │   ├── NoteEditor.jsx # Create / edit modal
│   │   │   └── NoteList.jsx   # Notes dashboard with full CRUD
│   │   ├── database.types.ts  # Generated from local Supabase schema
│   │   ├── App.jsx            # Auth gate (session → AuthForm or NoteList)
│   │   ├── App.css            # Application styles
│   │   └── index.css          # CSS custom properties + base reset
│   ├── .env.local             # Supabase URL + anon key (see Setup)
│   └── package.json
└── supabase/
    ├── migrations/
    │   ├── 20260401000001_create_users_and_notes.sql   # Schema
    │   └── 20260401000002_rls_users_and_notes.sql      # RLS policies
    ├── seed.sql               # 3 test users, 7 sample notes
    └── config.toml            # Local Supabase config (ports, project ID)
```

## Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) — `npm install -g supabase`
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — required by Supabase local dev

## Local setup

### 1. Start Supabase

```bash
cd supabase
supabase start
```

This pulls the Supabase Docker images on first run (may take a few minutes), then starts the full stack: Postgres, Auth, REST API, and Supabase Studio.

When it finishes you'll see output like:

```
API URL:      http://localhost:54321
DB URL:       postgresql://postgres:postgres@localhost:54322/postgres
Studio URL:   http://localhost:54323
anon key:     <your-anon-key>
```

### 2. Apply migrations and seed data

```bash
# still inside supabase/
supabase db reset
```

This drops and recreates the local database, runs all migration files in order, then runs `seed.sql`. Use this command any time you want a clean slate.

Seed accounts (password: `password123`):

| Email | Display name |
|---|---|
| alice@example.com | Alice |
| bob@example.com | Bob |
| carol@example.com | Carol |

### 3. Configure the frontend environment

Create `frontend/.env.local` with the values from `supabase start` output:

```bash
# frontend/.env.local
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<anon key from supabase start>
```

> The anon key is safe to expose to the browser. It only grants access subject to RLS policies — users can only read and write their own data.

### 4. Install dependencies and start the frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Regenerating database types

Run this whenever you change the schema (add a table, column, etc.):

```bash
cd supabase
supabase gen types typescript --local > ../frontend/src/database.types.ts
```

`src/lib/supabase.ts` passes the generated `Database` type to `createClient`, so the Supabase client has full TypeScript awareness of every table and column.

## How the app works

### Authentication

`App.jsx` subscribes to `supabase.auth.onAuthStateChange` on mount. This fires immediately with the current session, then again on every auth event (sign-in, sign-out, token refresh). Session state drives which view is rendered:

- `undefined` — still loading
- `null` — signed out → shows `AuthForm`
- `Session` object — signed in → shows `NoteList`

Sign-up creates the `auth.users` entry via Supabase Auth, then inserts a matching row in `public.users` (the public profile table).

### Row-Level Security

Both `public.users` and `public.notes` have RLS enabled and forced. Policies use `(select auth.uid())` — wrapping the call in a sub-select causes Postgres to evaluate it once per query rather than once per row, which is significantly faster on large tables.

The notes policies mean a `select * from notes` query from the client automatically returns only the signed-in user's rows. No `where user_id = ...` filter is needed in the application code.

### CRUD

`NoteList` fetches notes on mount. Create, update, and delete operations call the Supabase client directly and update local state using the functional `setState(curr => ...)` form to avoid stale closure bugs.

## Useful commands

```bash
# Open Supabase Studio (table editor, SQL runner, auth users)
open http://localhost:54323

# Check Supabase service status
supabase status

# Stop Supabase (preserves data)
supabase stop

# Stop and wipe all local data
supabase stop --no-backup

# Run a fresh migration (without resetting seed data)
supabase migration up

# Lint the frontend
cd frontend && npm run lint

# Build for production
cd frontend && npm run build
```
