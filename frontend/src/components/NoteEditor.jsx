import { useState } from 'react'

// NoteEditor is defined at module top level (rerender-no-inline-components).

/**
 * @param {{
 *   initial: import('../lib/supabase').Note | null,
 *   onSave: (title: string, content: string) => Promise<void>,
 *   onCancel: () => void
 * }} props
 */
export default function NoteEditor({ initial, onSave, onCancel }) {
  // Lazy state initialiser — the function is only called once on mount, not on
  // every render (rerender-lazy-state-init).
  const [title, setTitle] = useState(() => initial?.title ?? '')
  const [content, setContent] = useState(() => initial?.content ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(/** @type {string | null} */ (null))

  // Label derived from prop during render — no effect required
  // (rerender-derived-state-no-effect).
  const isEditing = initial !== null
  const heading = isEditing ? 'Edit note' : 'New note'
  const saveLabel = isEditing ? 'Save changes' : 'Create note'

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(title.trim(), content.trim())
    } catch (err) {
      setError(err.message ?? 'Failed to save note.')
      setSaving(false)
    }
  }

  return (
    <div className="editor-overlay">
      <div className="editor-card">
        <h2 className="editor-heading">{heading}</h2>

        <form onSubmit={handleSubmit} className="editor-form">
          <div className="field">
            <label htmlFor="note-title">Title</label>
            <input
              id="note-title"
              type="text"
              placeholder="Note title"
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="note-content">Content</label>
            <textarea
              id="note-content"
              placeholder="Write something…"
              rows={6}
              value={content}
              onChange={e => setContent(e.target.value)}
            />
          </div>

          {/* error is string | null — ternary prevents rendering "null" text
              (rendering-conditional-render) */}
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
              {saving ? 'Saving…' : saveLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
