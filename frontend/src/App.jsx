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

  // Theme is initialised from localStorage via lazy useState — the function
  // runs once on mount, never on re-render (rerender-lazy-state-init).
  const [theme, setTheme] = useState(
    () => localStorage.getItem('theme') ?? 'light'
  )

  // Apply theme to <html> as a data attribute so CSS selectors can target it.
  // Runs synchronously after every theme change — no extra effect needed
  // because the side-effect is trivial and co-located (rerender-move-effect-to-event).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

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

  function handleToggleTheme() {
    setTheme(t => (t === 'light' ? 'dark' : 'light'))
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  // Ternary used for all conditional branches — never && with non-boolean
  // values, which risks rendering "null", "0", or "undefined" as text
  // (rendering-conditional-render).
  return isLoading ? (
    <div className="app-loading" aria-live="polite">
      <div className="app-loading__inner">
        <span className="app-loading__title">Notes</span>
        <div className="app-loading__spinner" aria-hidden="true" />
      </div>
    </div>
  ) : session !== null ? (
    <NoteList
      userId={session.user.id}
      userEmail={session.user.email}
      theme={theme}
      onToggleTheme={handleToggleTheme}
      onSignOut={handleSignOut}
    />
  ) : (
    <AuthForm
      theme={theme}
      onToggleTheme={handleToggleTheme}
      onAuth={() => { /* session update handled by onAuthStateChange */ }}
    />
  )
}

export default App
