import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import NoteCard from './NoteCard'
import NoteEditor from './NoteEditor'
import ProfileEditor from './ProfileEditor'

// Stable sort comparator: pinned first, then newest first by created_at.
// Defined at module level so it is never recreated on re-render and can be
// shared by handleCreate and handleTogglePin (rerender-no-inline-components).
/** @param {import('../lib/supabase').Note} a @param {import('../lib/supabase').Note} b */
function pinSort(a, b) {
  return (
    Number(b.is_pinned) - Number(a.is_pinned) ||
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
}

// NoteList is defined at module top level (rerender-no-inline-components).

/**
 * @param {{ userId: string, userEmail: string | undefined, theme: string, onToggleTheme: () => void, onSignOut: () => void }} props
 */
export default function NoteList({ userId, userEmail, theme, onToggleTheme, onSignOut }) {
  const [notes, setNotes] = useState(/** @type {import('../lib/supabase').Note[]} */ ([]))
  const [fetchError, setFetchError] = useState(/** @type {string | null} */ (null))
  const [loadingNotes, setLoadingNotes] = useState(true)
  // editingNote: null  → editor hidden
  //              'new' → creating a new note
  //              Note  → editing that note
  const [editingNote, setEditingNote] = useState(
    /** @type {import('../lib/supabase').Note | 'new' | null} */ (null),
  )
  const [displayName, setDisplayName] = useState(/** @type {string | null} */ (null))
  const [profileEditorOpen, setProfileEditorOpen] = useState(false)

  // ── Fetch ────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false

    async function fetchData() {
      // Fire both requests in parallel — they are independent (async-parallel).
      const [notesResult, profileResult] = await Promise.all([
        supabase
          .from('notes')
          .select('*')
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false }),
        supabase
          .from('users')
          .select('display_name')
          .eq('id', userId)
          .single(),
      ])

      if (cancelled) return
      if (notesResult.error) {
        setFetchError(notesResult.error.message)
      } else {
        setNotes(notesResult.data ?? [])
      }
      setLoadingNotes(false)
      if (!profileResult.error) {
        setDisplayName(profileResult.data?.display_name ?? null)
      }
    }

    fetchData()
    return () => { cancelled = true }
  }, [])

  // ── Create ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (title, content) => {
    const { data, error } = await supabase
      .from('notes')
      .insert({ title, content: content || null, user_id: userId })
      .select()
      .single()

    if (error) throw error

    // Functional setState: insert then re-sort so a new (unpinned) note never
    // jumps in front of an existing pinned note (rerender-functional-setstate).
    setNotes(curr => [...curr, data].sort(pinSort))
    setEditingNote(null)
  }, [])

  // ── Update ───────────────────────────────────────────────────────────────

  const handleUpdate = useCallback(
    async (title, content) => {
      if (editingNote === null || editingNote === 'new') return

      const { data, error } = await supabase
        .from('notes')
        .update({ title, content: content || null })
        .eq('id', editingNote.id)
        .select()
        .single()

      if (error) throw error

      // Functional setState (rerender-functional-setstate).
      setNotes(curr => curr.map(n => (n.id === data.id ? data : n)))
      setEditingNote(null)
    },
    [editingNote],
  )

  // ── Pin / Unpin ─────────────────────────────────────────────────────────

  const handleTogglePin = useCallback(async (note) => {
    const { data, error } = await supabase
      .from('notes')
      .update({ is_pinned: !note.is_pinned })
      .eq('id', note.id)
      .select()
      .single()

    if (error) {
      alert(`Pin failed: ${error.message}`)
      return
    }

    // Functional setState: map the updated note in, then re-sort to match
    // the DB order (is_pinned DESC, created_at DESC) without a re-fetch
    // (rerender-functional-setstate).
    setNotes(curr => {
      const updated = curr.map(n => (n.id === data.id ? data : n))
      return [...updated].sort(pinSort)
    })
  }, [])

  // ── Profile ───────────────────────────────────────────────────────────────

  const handleProfileSave = useCallback(async (name) => {
    const { error } = await supabase
      .from('users')
      .update({ display_name: name })
      .eq('id', userId)
    if (error) throw error
    // Update header immediately without a re-fetch (rerender-functional-setstate).
    setDisplayName(name)
    setProfileEditorOpen(false)
  }, [])

  // ── Delete ───────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id) => {
    const { error } = await supabase.from('notes').delete().eq('id', id)
    if (error) {
      alert(`Delete failed: ${error.message}`)
      return
    }
    // Functional setState (rerender-functional-setstate).
    setNotes(curr => curr.filter(n => n.id !== id))
  }, [])

  // ── Derived ──────────────────────────────────────────────────────────────

  // `isEditorOpen` is derived from `editingNote` during render — no separate
  // boolean state needed (rerender-derived-state-no-effect).
  const isEditorOpen = editingNote !== null
  const editorInitial = editingNote === 'new' ? null : editingNote

  const onSave = editingNote === 'new' ? handleCreate : handleUpdate

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="notes-layout">
      <header className="notes-header">
        <h1 className="notes-title">Notes</h1>
        <div className="notes-header-actions">
          <span className="notes-user">{displayName ?? userEmail}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setProfileEditorOpen(true)}
          >
            Profile
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onToggleTheme}
            aria-label="Toggle day/night theme"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setEditingNote('new')}
          >
            + New note
          </button>
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="notes-main">
        {/* loadingNotes is boolean — && is safe here because the left side
            is a boolean, not a number (rendering-conditional-render applies
            to numeric/falsy-value conditions; boolean && is fine). */}
        {loadingNotes ? (
          <p className="notes-status">Loading…</p>
        ) : fetchError !== null ? (
          <p className="notes-status notes-error" role="alert">{fetchError}</p>
        ) : notes.length === 0 ? (
          <p className="notes-status">No notes yet. Create your first one!</p>
        ) : (
          <div className="notes-grid">
            {notes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                onEdit={setEditingNote}
                onDelete={handleDelete}
                onTogglePin={handleTogglePin}
              />
            ))}
          </div>
        )}
      </main>

      {/* isEditorOpen is a boolean derived from state — ternary prevents any
          risk of rendering a falsy value (rendering-conditional-render). */}
      {isEditorOpen ? (
        <NoteEditor
          initial={editorInitial}
          onSave={onSave}
          onCancel={() => setEditingNote(null)}
        />
      ) : null}
      {profileEditorOpen ? (
        <ProfileEditor
          initialName={displayName ?? userEmail ?? ''}
          onSave={handleProfileSave}
          onCancel={() => setProfileEditorOpen(false)}
        />
      ) : null}
    </div>
  )
}
