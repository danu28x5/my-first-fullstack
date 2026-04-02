// NoteCard is defined at module top level — not inside NoteList or any other
// component — so React never sees a new component type on re-render and
// avoids unnecessary remounts (rerender-no-inline-components).

/**
 * @param {{ note: import('../lib/supabase').Note, onEdit: (note: import('../lib/supabase').Note) => void, onDelete: (id: number) => void, onTogglePin: (note: import('../lib/supabase').Note) => void }} props
 */
export default function NoteCard({ note, onEdit, onDelete, onTogglePin }) {
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
        <button
          type="button"
          className={`btn btn-ghost btn-pin${note.is_pinned ? ' btn-pin--active' : ''}`}
          onClick={() => onTogglePin(note)}
          aria-label={note.is_pinned ? 'Unpin note' : 'Pin note'}
        >
          📌
        </button>
        <div className="note-card-actions-end">
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
            onClick={() => onDelete(note.id)}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}
