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
  // True after a successful sign-up when email confirmation is required.
  // Derived from server response, not a separate effect (rerender-derived-state-no-effect).
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

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
          options: { data: { display_name: displayName || email } },
        })
        if (authError) throw authError

        // The database trigger (handle_new_user) creates the public.users
        // profile row automatically — no client-side insert needed.
        //
        // When email confirmation is enabled (production), data.session is
        // null until the user clicks the confirmation link. Detect this and
        // show a message instead of redirecting (rerender-derived-state-no-effect:
        // derive the confirmation state from the response, not extra state).
        if (data.session === null) {
          setAwaitingConfirmation(true)
          return
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

        {/* Ternary: awaitingConfirmation is boolean so && would be safe, but
            ternary is used consistently for all conditional views in this file
            (rendering-conditional-render). */}
        {awaitingConfirmation ? (
          <>
            <p className="auth-subtitle">Check your email</p>
            <p className="auth-confirm-message">
              We sent a confirmation link to <strong>{email}</strong>.
              Click it to activate your account and sign in.
            </p>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setAwaitingConfirmation(false); setMode('signin') }}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <p className="auth-subtitle">{isSignUp ? 'Create your account' : 'Welcome back'}</p>

            <form onSubmit={handleSubmit} className="auth-form">
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
          </>
        )}
      </div>
    </div>
  )
}
