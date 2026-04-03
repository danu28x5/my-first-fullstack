import { useState } from 'react'

// NoteEditor is defined at module top level (rerender-no-inline-components).

/**
 * @param {{
 *   initial: import('../lib/supabase').NoteWithTags | null,
 *   allUserTags: import('../lib/supabase').Tag[],
 *   onSave: (title: string, content: string, selectedTags: {id: number, name: string}[]) => Promise<void>,
 *   onCreateTag: (name: string) => Promise<{id: number, name: string}>,
 *   onCancel: () => void
 * }} props
 */
export default function NoteEditor({ initial, allUserTags, onSave, onCreateTag, onCancel }) {
  // Lazy state initialisers -- each function is only called once on mount, not on
  // every render (rerender-lazy-state-init).
  const [title, setTitle] = useState(() => initial?.title ?? '')
  const [content, setContent] = useState(() => initial?.content ?? '')
  const [selectedTags, setSelectedTags] = useState(() =>
    initial?.note_tags?.flatMap(nt => (nt.tags !== null ? [nt.tags] : [])) ?? []
  )
  const [tagInput, setTagInput] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(/** @type {string | null} */ (null))

  // All derived during render -- no effects needed (rerender-derived-state-no-effect).
  const isEditing = initial !== null
  const heading = isEditing ? 'Edit note' : 'New note'
  const saveLabel = isEditing ? 'Save changes' : 'Create note'

  // Build a Set of selected IDs for O(1) membership checks (js-set-map-lookups).
  const selectedTagIds = new Set(selectedTags.map(t => t.id))

  const trimmedInput = tagInput.trim()

  // Suggestions: unselected tags whose name contains the current input (case-insensitive).
  const filteredSuggestions = allUserTags.filter(
    t => !selectedTagIds.has(t.id) &&
         t.name.toLowerCase().includes(trimmedInput.toLowerCase())
  )

  // Allow "create" only when input is non-empty and the exact name does not already exist.
  const canCreateTag =
    trimmedInput.length > 0 &&
    !allUserTags.some(t => t.name.toLowerCase() === trimmedInput.toLowerCase())

  const dropdownVisible = showDropdown && (filteredSuggestions.length > 0 || canCreateTag)

  // -- Handlers --

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Title is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(title.trim(), content.trim(), selectedTags)
    } catch (err) {
      setError(err.message ?? 'Failed to save note.')
      setSaving(false)
    }
  }

  function handleSelectTag(tag) {
    // Functional setState -- no stale closure risk (rerender-functional-setstate).
    setSelectedTags(curr => [...curr, tag])
    setTagInput('')
    setShowDropdown(false)
  }

  function handleRemoveTag(tagId) {
    setSelectedTags(curr => curr.filter(t => t.id !== tagId))
  }

  async function handleCreateAndSelectTag() {
    if (!canCreateTag) return
    try {
      const tag = await onCreateTag(trimmedInput)
      handleSelectTag(tag)
    } catch (err) {
      setError(err.message ?? 'Failed to create tag.')
    }
  }

  // -- Render --

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
              placeholder="Write something..."
              rows={6}
              value={content}
              onChange={e => setContent(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Tags</label>
            <div className="tag-dropdown-wrapper">
              <div className="tag-input-wrapper">
                {selectedTags.map(tag => (
                  <span key={tag.id} className="tag-pill tag-pill--removable">
                    {tag.name}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag.name}`}
                      onClick={() => handleRemoveTag(tag.id)}
                    >
                      x
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  placeholder={selectedTags.length === 0 ? 'Add tags...' : ''}
                  value={tagInput}
                  onChange={e => { setTagInput(e.target.value); setShowDropdown(true) }}
                  onFocus={() => setShowDropdown(true)}
                  onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (filteredSuggestions.length > 0) {
                        handleSelectTag(filteredSuggestions[0])
                      } else if (canCreateTag) {
                        handleCreateAndSelectTag()
                      }
                    }
                    if (e.key === 'Escape') setShowDropdown(false)
                  }}
                />
              </div>

              {dropdownVisible ? (
                <div className="tag-dropdown" role="listbox">
                  {filteredSuggestions.map(tag => (
                    <button
                      key={tag.id}
                      type="button"
                      role="option"
                      className="tag-dropdown-item"
                      onMouseDown={e => { e.preventDefault(); handleSelectTag(tag) }}
                    >
                      {tag.name}
                    </button>
                  ))}
                  {canCreateTag ? (
                    <button
                      type="button"
                      role="option"
                      className="tag-dropdown-item tag-dropdown-item--create"
                      onMouseDown={e => { e.preventDefault(); handleCreateAndSelectTag() }}
                    >
                      Create &ldquo;{trimmedInput}&rdquo;
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

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
              {saving ? 'Saving...' : saveLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}