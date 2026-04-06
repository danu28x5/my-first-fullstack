import AttachmentPreview from './AttachmentPreview'
import AvatarImage from './AvatarImage'

// NoteCard is defined at module top level — not inside NoteList or any other
// component — so React never sees a new component type on re-render and
// avoids unnecessary remounts (rerender-no-inline-components).

/**
 * @param {{
 *   note:             import('../lib/supabase').NoteWithTags,
 *   isArchiveView:    boolean,
 *   isSharedView?:    boolean,
 *   permission?:      import('../lib/supabase').SharePermission | null,
 *   ownerInfo?:       { displayName: string | null; avatarSignedUrl: string | null } | null,
 *   onEdit:           (note: import('../lib/supabase').NoteWithTags) => void,
 *   onArchive:        (id: number) => void,
 *   onUnarchive:      (id: number) => void,
 *   onDeletePermanently: (id: number) => void,
 *   onTogglePin:      (note: import('../lib/supabase').NoteWithTags) => void,
 *   onShare?:         (note: import('../lib/supabase').NoteWithTags) => void,
 * }} props
 */
export default function NoteCard({
  note,
  isArchiveView,
  isSharedView = false,
  permission = null,
  ownerInfo = null,
  onEdit,
  onArchive,
  onUnarchive,
  onDeletePermanently,
  onTogglePin,
  onShare,
}) {
  // Format date during render — derived value, no state needed
  // (rerender-derived-state-no-effect).
  const formattedDate = new Date(note.updated_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  // Derived permission flags — computed once per render, no extra state needed.
  const isOwner     = !isSharedView
  const canEdit     = isOwner || permission === 'edit'
  const canPin      = isOwner && !isArchiveView
  const canArchive  = isOwner && !isArchiveView
  const canUnarchive = isOwner && isArchiveView
  const canDelete   = isOwner && isArchiveView
  const canShare    = isOwner && !isArchiveView && !isSharedView

  return (
    <article className={`note-card${note.is_pinned && !isSharedView ? ' note-card--pinned' : ''}${isSharedView ? ' note-card--shared-view' : ''}`}>
      {/* "Shared by" strip — shown only in the Shared with me view */}
      {isSharedView && ownerInfo !== null ? (
        <div className="note-card-owner-info">
          <AvatarImage
            key={ownerInfo.avatarSignedUrl}
            signedUrl={ownerInfo.avatarSignedUrl}
            displayName={ownerInfo.displayName}
            email={null}
            size="sm"
          />
          <span className="note-card-owner-label">
            Shared by {ownerInfo.displayName ?? 'Unknown'}
          </span>
          {permission !== null ? (
            <span className="note-card-perm-badge">
              {permission === 'edit' ? 'Editor' : 'Viewer'}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="note-card-body">
        <h3 className="note-card-title">{note.title}</h3>
        {/* Content is string | null — ternary prevents rendering "null" text
            (rendering-conditional-render). */}
        {note.content !== null ? (
          <p className="note-card-content">{note.content}</p>
        ) : null}
        {/* Attachment strip — read-only thumbnails/icons for cards.
            Images and PDFs are split into separate sub-rows.
            Derived from note_attachments during render — no extra state needed
            (rerender-derived-state-no-effect rule).
            Optional-chaining guards in case the field is absent on a realtime
            INSERT before the client queries the join. */}
        {note.note_attachments?.length > 0 ? (() => {
          const images = note.note_attachments.filter(a => a.mime_type.startsWith('image/'))
          const pdfs   = note.note_attachments.filter(a => !a.mime_type.startsWith('image/'))
          return (
            <div className="note-card-attachments">
              {images.length > 0 ? (
                <div className="note-card-attachments__images">
                  {images.map(a => <AttachmentPreview key={a.id} attachment={a} />)}
                </div>
              ) : null}
              {pdfs.length > 0 ? (
                <div className="note-card-attachments__pdfs">
                  {pdfs.map(a => <AttachmentPreview key={a.id} attachment={a} />)}
                </div>
              ) : null}
            </div>
          )
        })() : null}
        {/* Tag pills — shown when the note has at least one tag.
            note_tags may be undefined on create before re-fetch, so optional
            chaining guards the length check (rendering-conditional-render). */}
        {note.note_tags?.length > 0 ? (
          <div className="note-card-tags">
            {note.note_tags.map(nt =>
              nt.tags !== null ? (
                <span key={nt.tags.id} className="tag-pill">
                  {nt.tags.name}
                </span>
              ) : null
            )}
          </div>
        ) : null}
        <time className="note-card-date" dateTime={note.updated_at}>
          {formattedDate}
        </time>
      </div>
      <div className="note-card-actions">
        {/* Pin button — owner active view only (rendering-conditional-render). */}
        {canPin && onTogglePin !== undefined ? (
          <button
            type="button"
            className={`btn btn-ghost btn-pin${note.is_pinned ? ' btn-pin--active' : ''}`}
            onClick={() => onTogglePin(note)}
            aria-label={note.is_pinned ? 'Unpin note' : 'Pin note'}
          >
            📌
          </button>
        ) : null}
        <div className="note-card-actions-end">
          {/* Archive view: owner gets Unarchive + Delete.
              Active view (shared): viewer gets nothing; editor gets Edit only.
              Active view (owner): Edit + Archive + Share.
              (rendering-conditional-render) */}
          {canUnarchive && onUnarchive !== undefined ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onUnarchive(note.id)}
              >
                Unarchive
              </button>
              {canDelete && onDeletePermanently !== undefined ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => onDeletePermanently(note.id)}
                >
                  Delete
                </button>
              ) : null}
            </>
          ) : canEdit && onEdit !== undefined ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onEdit(note)}
              >
                Edit
              </button>
              {canArchive && onArchive !== undefined ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => onArchive(note.id)}
                >
                  Archive
                </button>
              ) : null}
              {canShare && onShare !== undefined ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => onShare(note)}
                  aria-label="Share note"
                >
                  Share
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </article>
  )
}
