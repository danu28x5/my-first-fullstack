import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import AvatarImage from './AvatarImage'

// ProfileEditor is defined at module top level (rerender-no-inline-components).

const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2 MiB

/**
 * @param {{
 *   initialName: string,
 *   userId: string,
 *   initialAvatarSignedUrl: string | null,
 *   onSave: (name: string) => Promise<void>,
 *   onAvatarSave: (path: string) => Promise<void>,
 *   onCancel: () => void
 * }} props
 */
export default function ProfileEditor({
  initialName,
  userId,
  initialAvatarSignedUrl,
  onSave,
  onAvatarSave,
  onCancel,
}) {
  // Lazy state initialisers — each runs once on mount (rerender-lazy-state-init).
  const [name, setName] = useState(() => initialName)
  // previewUrl tracks what the avatar <img> shows: starts as the signed URL
  // from the DB, swaps to a local object URL during upload, then to the new
  // signed URL on success (or reverts to the original on failure).
  const [previewUrl, setPreviewUrl] = useState(
    /** @type {string | null} */ (() => initialAvatarSignedUrl)
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(/** @type {string | null} */ (null))
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(/** @type {string | null} */ (null))
  // Ref to the hidden <input type="file"> so the camera overlay can trigger it
  // without exposing it in the DOM flow.
  const fileInputRef = useRef(/** @type {HTMLInputElement | null} */ (null))

  // ── Avatar upload ────────────────────────────────────────────────────────
  // All upload logic lives in the event handler — not in a useEffect — because
  // this is a direct response to a user interaction (rerender-move-effect-to-event).

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    if (!file) return

    // Client-side validation — fast, synchronous, no network call needed.
    if (!file.type.startsWith('image/')) {
      setUploadError('File must be an image (JPEG, PNG, WebP or GIF).')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setUploadError('File must be under 2 MB.')
      return
    }

    // Optimistic preview: show the local file immediately so the user sees
    // instant feedback while the upload runs in the background.
    const localPreview = URL.createObjectURL(file)
    setPreviewUrl(localPreview)
    setUploading(true)
    setUploadError(null)

    const path = `${userId}/avatar.png`

    try {
      // upsert: true replaces the existing object at the same path without a
      // 409 conflict error — this is what makes subsequent uploads work.
      const { error: storageError } = await supabase.storage
        .from('avatars')
        .upload(path, file, { upsert: true, contentType: file.type })

      if (storageError) {
        setPreviewUrl(initialAvatarSignedUrl)
        setUploadError(storageError.message)
        return
      }

      // Persist the storage path (not a URL) to the database.
      const { error: dbError } = await supabase
        .from('users')
        .update({ avatar_path: path })
        .eq('id', userId)

      if (dbError) {
        setPreviewUrl(initialAvatarSignedUrl)
        setUploadError(dbError.message)
        return
      }

      // Notify the parent (NoteList) so it refreshes the signed URL used in
      // the header — this is what makes the header update immediately.
      await onAvatarSave(path)
    } finally {
      setUploading(false)
      // Release the blob memory — the object URL is no longer rendered after
      // the upload succeeds (previewUrl is now a real signed URL from the parent)
      // or after a failure (reverted to initialAvatarSignedUrl).
      URL.revokeObjectURL(localPreview)
      // Reset the input so picking the same file again fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ── Display-name save ────────────────────────────────────────────────────

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

        {/* ── Avatar section ──────────────────────────────────────────── */}
        <div className="avatar-upload-section">
          <div className="avatar-upload-wrapper">
            {/* key=previewUrl resets AvatarImage's imgError state when the
                URL changes — the keyed-reset pattern avoids storing derived
                error state in an effect (rerender-derived-state-no-effect). */}
            <AvatarImage
              key={previewUrl}
              signedUrl={previewUrl}
              displayName={name}
              size="lg"
            />

            {/* Show spinner overlay while uploading; camera overlay otherwise. */}
            {uploading ? (
              <div className="avatar-spinner-overlay" aria-label="Uploading…">
                <div className="avatar-spinner" />
              </div>
            ) : (
              <div
                className="avatar-upload-overlay"
                onClick={() => fileInputRef.current?.click()}
                role="button"
                aria-label="Change profile photo"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click() }}
              >
                {/* Camera icon — inline SVG so no extra network request. */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </div>
            )}

            {/* Hidden file input — triggered programmatically by the overlay. */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={handleFileChange}
              disabled={uploading}
              style={{ display: 'none' }}
              aria-hidden="true"
            />
          </div>

          {/* uploadError is string | null — ternary prevents rendering "null"
              (rendering-conditional-render). */}
          {uploadError !== null ? (
            <p className="editor-error" role="alert">{uploadError}</p>
          ) : null}
        </div>

        {/* ── Display name form ───────────────────────────────────────── */}
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
