import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import AuthForm from './components/AuthForm'
import NoteList from './components/NoteList'
import './App.css'

// Imports are direct (not barrel) — each component and the Supabase client
// are imported from their exact source file (bundle-barrel-imports).

function App() {
  // session: undefined = loading, null = signed out, Session = signed in.
  // This is the Supabase auth idiom; three distinct states from one value.
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    // Read the current session on mount.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
    })

    // Subscribe to future auth state changes (sign-in, sign-out, token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  // `isLoading` is derived from session during render — no separate boolean
  // state or effect needed (rerender-derived-state-no-effect).
  const isLoading = session === undefined

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  // Ternary used for all conditional branches — never && with non-boolean
  // values, which risks rendering "null", "0", or "undefined" as text
  // (rendering-conditional-render).
  return isLoading ? (
    <div className="app-loading" aria-live="polite">Loading...</div>
  ) : session !== null ? (
    <NoteList
      userId={session.user.id}
      userEmail={session.user.email}
      onSignOut={handleSignOut}
    />
  ) : (
    <AuthForm onAuth={() => { /* session update handled by onAuthStateChange */ }} />
  )
}

export default App
