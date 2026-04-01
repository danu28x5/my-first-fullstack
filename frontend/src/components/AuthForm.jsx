import { useState } from 'react'
import { supabase } from '../lib/supabase'

// AuthForm is defined at module top level — never inside another component.
// Defining components inside other components creates a new type on every
// render, causing React to fully remount them (rerender-no-inline-components).

/**
 * @param {{ onAuth: () => void }} props
 */
export default function AuthForm({ onAuth }) {
  const [mode, setMode] = useState(/** @type {'signin' | 'signup'} */ ('signin'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(/** @type {string | null} */ (null))
  const [loading, setLoading] = useState(false)

  // Label is derived from `mode` during render — no effect or extra state
  // needed (rerender-derived-state-no-effect).
  const isSignUp = mode === 'signup'
  const submitLabel = isSignUp ? 'Create account' : 'Sign in'
  const toggleLabel = isSignUp
    ? 'Already have an account? Sign in'
    : "Don't have an account? Sign up"

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      if (isSignUp) {
        const { data, error: authError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName } },
        })
        if (authError) throw authError

        // After sign-up, insert the public profile row.
        // The auth user is created first; the profile row references it.
        if (data.user) {
          const { error: profileError } = await supabase
            .from('users')
            .insert({ id: data.user.id, email, display_name: displayName || email })
          // A conflict here means the profile already exists (e.g. re-run seed).
          // We only surface genuine errors.
          if (profileError && profileError.code !== '23505') throw profileError
        }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (authError) throw authError
      }

      onAuth()
    } catch (err) {
      setError(err.message ?? 'An unexpected error occurred.')
    } finally {
      setLoading(false)
    }
  }

  function toggleMode() {
    setMode(m => (m === 'signin' ? 'signup' : 'signin'))
    setError(null)
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">Notes</h1>
        <p className="auth-subtitle">{isSignUp ? 'Create your account' : 'Welcome back'}</p>

        <form onSubmit={handleSubmit} className="auth-form">
          {/* Display name field only shown for sign-up (ternary, not &&,
              because the field value is a string — rendering-conditional-render) */}
          {isSignUp ? (
            <div className="field">
              <label htmlFor="display-name">Name</label>
              <input
                id="display-name"
                type="text"
                autoComplete="name"
                placeholder="Your name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
              />
            </div>
          ) : null}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              placeholder="••••••••"
              required
              minLength={6}
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          {/* Error is a string or null — ternary prevents rendering "null" text
              (rendering-conditional-render) */}
          {error !== null ? (
            <p className="auth-error" role="alert">{error}</p>
          ) : null}

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Please wait…' : submitLabel}
          </button>
        </form>

        <button type="button" className="btn btn-ghost" onClick={toggleMode}>
          {toggleLabel}
        </button>
      </div>
    </div>
  )
}
