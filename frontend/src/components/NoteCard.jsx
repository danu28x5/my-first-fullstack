// NoteCard is defined at module top level — not inside NoteList or any other
// component — so React never sees a new component type on re-render and
// avoids unnecessary remounts (rerender-no-inline-components).

/**
 * @param {{
 *   note: import('../lib/supabase').Note,
 *   isArchiveView: boolean,
 *   onEdit: (note: import('../lib/supabase').Note) => void,
 *   onArchive: (id: number) => void,
 *   onUnarchive: (id: number) => void,
 *   onDeletePermanently: (id: number) => void,
 *   onTogglePin: (note: import('../lib/supabase').Note) => void
 * }} props
 */
export default function NoteCard({ note, isArchiveView, onEdit, onArchive, onUnarchive, onDeletePermanently, onTogglePin }) {
  // Format date during render — derived value, no state needed
  // (rerender-derived-state-no-effect).
  const formattedDate = new Date(note.updated_at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

  return (
    <article className={`note-card${note.is_pinned ? ' note-card--pinned' : ''}`}>
      <div className="note-card-body">
        <h3 className="note-card-title">{note.title}</h3>
        {/* Content is string | null — ternary prevents rendering "null" text
            (rendering-conditional-render). */}
        {note.content !== null ? (
          <p className="note-card-content">{note.content}</p>
        ) : null}
        <time className="note-card-date" dateTime={note.updated_at}>
          {formattedDate}
        </time>
      </div>
      <div className="note-card-actions">
        {/* Pin button only shown in active view (rendering-conditional-render). */}
        {!isArchiveView ? (
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
          {/* Archive view: Unarchive + Delete Permanently.
              Active view: Edit + Archive (rendering-conditional-render). */}
          {isArchiveView ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onUnarchive(note.id)}
              >
                Unarchive
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onDeletePermanently(note.id)}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onEdit(note)}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => onArchive(note.id)}
              >
                Archive
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
