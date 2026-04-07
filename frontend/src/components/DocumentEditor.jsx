import { useState } from 'react'
import { supabase } from '../lib/supabase'
/** @typedef {import('../lib/supabase').Document} Document */

/**
 * Placeholder editor for a single Markdown document.
 * Shows title input + body textarea inside the standard editor overlay.
 *
 * @param {{
 *   document: Document,
 *   onSave: (doc: Document) => void,
 *   onCancel: () => void,
 * }} props
 */
export default function DocumentEditor({ document, onSave, onCancel }) {
  const [title, setTitle] = useState(document.title)
  const [body, setBody] = useState(document.body ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(/** @type {string | null} */ (null))

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const { data, error: err } = await supabase
      .from('documents')
      .update({ title: title.trim() || 'Untitled document', body: body || null })
      .eq('id', document.id)
      .select()
      .single()

    if (err) {
      setError(err.message)
      setSaving(false)
      return
    }

    onSave(data)
  }

  return (
    <div className="editor-overlay" onMouseDown={onCancel}>
      {/* Stop clicks inside the card from closing the overlay */}
      <form
        className="editor-card doc-editor-card"
        onSubmit={handleSubmit}
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 className="editor-heading">Edit document</h2>

        <div className="editor-form">
          <div className="field">
            <label htmlFor="doc-title">Title</label>
            <input
              id="doc-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="doc-body">Content (Markdown)</label>
            <textarea
              id="doc-body"
              className="doc-editor-body"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Write your Markdown here…"
            />
          </div>

          {error !== null ? (
            <p className="editor-error" role="alert">{error}</p>
          ) : null}

          <div className="editor-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCancel}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
