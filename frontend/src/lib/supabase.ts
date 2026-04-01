import { createClient } from '@supabase/supabase-js'
import type { Database } from '../database.types'

// Client is created once at module level — never inside a component or hook.
// This avoids creating a new WebSocket connection on every render and is the
// correct pattern for a browser singleton (server-hoist-static-io).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)

// Convenience type aliases derived from the generated Database type so
// components never have to import Database directly (bundle-barrel-imports:
// import from the specific source, not a re-exporting barrel).
export type Note = Database['public']['Tables']['notes']['Row']
export type NoteInsert = Database['public']['Tables']['notes']['Insert']
export type NoteUpdate = Database['public']['Tables']['notes']['Update']
