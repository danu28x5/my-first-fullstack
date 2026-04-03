import { useRef, useState, useTransition } from 'react'
import AttachmentPreview from './AttachmentPreview'

// NoteEditor is defined at module top level (rerender-no-inline-components).

// Module-level constants — never recreated on re-render (rendering-hoist-jsx rule).
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
const MAX_BYTES = 10 * 1024 * 1024 // 10 MiB

/**
 * @param {{
 *   initial: import('../lib/supabase').NoteWithTags | null,
 *   allUserTags: import('../lib/supabase').Tag[],
 *   onSave: (title: string, content: string, selectedTags: {id: number, name: string}[], pendingFiles: File[]) => Promise<void>,
 *   onCreateTag: (name: string) => Promise<{id: number, name: string}>,
 *   onCancel: () => void,
 *   noteId: number | null,
 *   noteAttachments: import('../lib/supabase').NoteAttachmentPreview[],
 *   onAttachFile: (file: File) => Promise<void>,
 *   onDeleteAttachment: (attachment: import('../lib/supabase').NoteAttachmentPreview) => Promise<void>,
 * }} props
 */
export default function NoteEditor({
  initial,
  allUserTags,
  onSave,
  onCreateTag,
  onCancel,
  noteId,
  noteAttachments,
  onAttachFile,
  onDeleteAttachment,
}) {
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

  // Pending files are queued here for new notes (no note id yet); they are
  // uploaded in NoteList.handleCreate after the note row is created.
  // In edit mode, onAttachFile uploads immediately via useTransition below.
  const [pendingFiles, setPendingFiles] = useState(/** @type {File[]} */ ([]))
  const [uploadError, setUploadError] = useState(/** @type {string | null} */ (null))

  // useTransition manages the upload loading state automatically — isPending
  // resets correctly even if the transition throws (rendering-usetransition-loading rule).
  const [isUploading, startUpload] = useTransition()

  // Ref to hidden <input type="file"> so the button can trigger it
  // without the input appearing in the DOM flow.
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null))

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
      await onSave(title.trim(), content.trim(), selectedTags, pendingFiles)
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

  // File picker handler — lives in the event handler, not a useEffect, because
  // this is a direct response to a user interaction (rerender-move-effect-to-event).
  function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return

    // Synchronous validation BEFORE any async work — fast, no network call
    // needed (async-cheap-condition-before-await rule).
    if (!ALLOWED_TYPES.has(file.type)) {
      setUploadError('Unsupported file type. Allowed: JPEG, PNG, WebP, GIF, PDF.')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    if (file.size > MAX_BYTES) {
      setUploadError(`File must be under ${MAX_BYTES / 1024 / 1024} MB.`)
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }

    setUploadError(null)

    if (noteId !== null) {
      // Edit mode: upload immediately via useTransition so isPending is
      // managed automatically (rendering-usetransition-loading rule).
      startUpload(async () => {
        try {
          await onAttachFile(file)
        } catch (err) {
          setUploadError(err.message ?? 'Upload failed.')
        }
      })
    } else {
      // New note mode: queue the file; NoteList.handleCreate will upload it
      // after the note row is created and we have a note id.
      setPendingFiles(curr => [...curr, file])
    }

    // Reset so picking the same file again fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleRemovePendingFile(index) {
    setPendingFiles(curr => curr.filter((_, i) => i !== index))
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

          {/* ── Attachments section ───────────────────────────────────── */}
          <div className="field">
            <label>Attachments</label>

            {/* Existing (committed) attachments — all rendered as uniform
                editor rows via AttachmentPreview's editor mode. */}
            {noteAttachments.length > 0 ? (
              <div className="attachment-list">
                {noteAttachments.map(a => (
                  <AttachmentPreview key={a.id} attachment={a} onDelete={onDeleteAttachment} />
                ))}
              </div>
            ) : null}

            {/* Pending files queued for upload on Save (new-note mode only) */}
            {pendingFiles.length > 0 ? (
              <div className="attachment-list attachment-list--pending">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="pending-attachment">
                    <span className="pending-attachment__name">{f.name}</span>
                    <button
                      type="button"
                      className="attachment-preview__delete-btn"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => handleRemovePendingFile(i)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Hidden file input — triggered by the button below */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              onChange={handleFileChange}
              hidden
            />

            <button
              type="button"
              className="btn btn-secondary btn-sm attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || saving}
            >
              {isUploading ? 'Uploading…' : 'Attach file'}
            </button>

            {uploadError !== null ? (
              <p className="editor-error" role="alert">{uploadError}</p>
            ) : null}
          </div>

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