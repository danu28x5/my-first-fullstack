import { useState } from 'react'

// ProfileEditor is defined at module top level (rerender-no-inline-components).

/**
 * @param {{
 *   initialName: string,
 *   onSave: (name: string) => Promise<void>,
 *   onCancel: () => void
 * }} props
 */
export default function ProfileEditor({ initialName, onSave, onCancel }) {
  // Lazy state initialiser — runs once on mount, not on every render
  // (rerender-lazy-state-init).
  const [name, setName] = useState(() => initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(/** @type {string | null} */ (null))

  async function handleSubmit(e) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Full name is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(name.trim())
    } catch (err) {
      setError(err.message ?? 'Failed to save profile.')
      setSaving(false)
    }
  }

  return (
    <div className="editor-overlay">
      <div className="editor-card">
        <h2 className="editor-heading">Edit profile</h2>

        <form onSubmit={handleSubmit} className="editor-form">
          <div className="field">
            <label htmlFor="profile-name">Full name</label>
            <input
              id="profile-name"
              type="text"
              placeholder="Your name"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          </div>

          {/* error is string | null — ternary prevents rendering "null" text
              (rendering-conditional-render). */}
          {error !== null ? (
            <p className="editor-error" role="alert">{error}</p>
          ) : null}

          <div className="editor-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
