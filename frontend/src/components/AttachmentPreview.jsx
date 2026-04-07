import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// AttachmentPreview is defined at module top level (rerender-no-inline-components).

// Inline SVG for PDF / unknown file — no extra network request.
function FileIcon() {
  return (
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
      className="attachment-preview__file-icon"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

// Inline SVG for image attachments — mountain + circle picture icon.
function ImageIcon() {
  return (
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
      className="attachment-preview__file-icon"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

// Format byte counts as a human-readable string.
// Module-level so it is never recreated on re-render (rendering-hoist-jsx rule).
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}\u00a0B`
  return `${Math.round(bytes / 1024)}\u00a0KB`
}

/**
 * Renders one attachment.
 *
 * **Card mode** (`onDelete` absent):
 * - Images: signed-URL thumbnail (64x64) with error fallback.
 * - PDFs: file icon + filename.
 *
 * **Editor mode** (`onDelete` present):
 * - All types: uniform row — [icon] [filename] [size on hover] [× button].
 *
 * @param {{
 *   attachment: import('../lib/supabase').NoteAttachmentPreview,
 *   onDelete?: (attachment: import('../lib/supabase').NoteAttachmentPreview) => void,
 * }} props
 */
export default function AttachmentPreview({ attachment, onDelete }) {
  const [signedUrl, setSignedUrl] = useState(/** @type {string | null} */ (null))
  const [imgError, setImgError] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  const isImage = attachment.mime_type.startsWith('image/')
  // Editor mode: render a uniform text row regardless of file type.
  // Derived from props during render — no extra state needed
  // (rerender-derived-state-no-effect rule).
  const isEditorMode = onDelete !== undefined

  // Fetch a signed URL for:
  //  – card mode (all types, for click-to-open / thumbnail)
  //  – editor mode images (to show a small thumbnail in the row)
  // Signed URLs are generated at render time and never persisted to the DB.
  useEffect(() => {
    if (isEditorMode && !isImage) return
    let cancelled = false

    supabase.storage
      .from('attachments')
      .createSignedUrl(attachment.storage_path, 3600)
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setSignedUrl(data.signedUrl)
      })

    return () => { cancelled = true }
  }, [attachment.storage_path, isImage, isEditorMode])

  // -- Editor mode: uniform row for all file types --------------------------
  if (isEditorMode) {
    return (
      <div className="attachment-preview attachment-preview--editor">
        {isImage ? (
          signedUrl && !imgError ? (
            <img
              src={signedUrl}
              alt={attachment.file_name}
              className="attachment-preview__img--editor-thumb"
              onError={() => setImgError(true)}
            />
          ) : (
            <ImageIcon />
          )
        ) : (
          <FileIcon />
        )}
        <span className="attachment-preview__filename" title={attachment.file_name}>
          {attachment.file_name}
        </span>
        {/* Size badge — hidden by default, revealed on row hover via CSS.
            aria-hidden so screen readers skip the redundant size info;
            the aria-label on the delete button already names the file. */}
        <span className="attachment-preview__size" aria-hidden="true">
          {formatSize(attachment.byte_size)}
        </span>
        <button
          type="button"
          className="attachment-preview__delete-btn"
          aria-label={`Remove ${attachment.file_name}`}
          onClick={() => onDelete(attachment)}
        >
          &times;
        </button>
      </div>
    )
  }

  // -- Card mode (read-only) ------------------------------------------------
  return (
    <>
      <div className={`attachment-preview attachment-preview--${isImage ? 'image' : 'pdf'}`}>
        {isImage ? (
          // key=signedUrl resets imgError when the URL changes — keyed-reset
          // pattern avoids storing derived error state in an effect
          // (rerender-derived-state-no-effect rule, same as AvatarImage).
          signedUrl && !imgError ? (
            <button
              type="button"
              className="attachment-preview__img-btn"
              onClick={() => setLightboxOpen(true)}
              aria-label={`View ${attachment.file_name}`}
            >
              <img
                key={signedUrl}
                src={signedUrl}
                alt={attachment.file_name}
                className="attachment-preview__img"
                onError={() => setImgError(true)}
              />
            </button>
          ) : (
            <div className="attachment-preview__img-placeholder">
              <FileIcon />
            </div>
          )
        ) : (
          <a
            href={signedUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="attachment-preview__pdf"
            aria-label={`Open ${attachment.file_name}`}
          >
            <FileIcon />
            <span className="attachment-preview__filename" title={attachment.file_name}>
              {attachment.file_name}
            </span>
          </a>
        )}
      </div>
      {lightboxOpen ? (
        <div
          className="attachment-lightbox"
          onClick={() => setLightboxOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={attachment.file_name}
        >
          <img
            src={signedUrl}
            alt={attachment.file_name}
            className="attachment-lightbox__img"
          />
        </div>
      ) : null}
    </>
  )
}
