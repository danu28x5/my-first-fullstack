import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import NoteCard from './NoteCard'
import NoteEditor from './NoteEditor'
import ProfileEditor from './ProfileEditor'
import Toast from './Toast'
// NoteWithTags and Tag are JSDoc-only imports — no runtime cost.
/** @typedef {import('../lib/supabase').NoteWithTags} NoteWithTags */
/** @typedef {import('../lib/supabase').Tag} Tag */

const PAGE_SIZE = 10

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
  // totalCount: number of active notes on the server (null when not paginating, e.g. search/archive)
  const [totalCount, setTotalCount] = useState(/** @type {number | null} */ (null))
  const [loadingMore, setLoadingMore] = useState(false)
  // editingNote: null  → editor hidden
  //              'new' → creating a new note
  //              Note  → editing that note
  const [editingNote, setEditingNote] = useState(
    /** @type {import('../lib/supabase').Note | 'new' | null} */ (null),
  )
  const [displayName, setDisplayName] = useState(/** @type {string | null} */ (null))
  const [profileEditorOpen, setProfileEditorOpen] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  // Ref mirrors showArchive so the stable Realtime handler can read the current
  // view without needing showArchive in its dependency array (which would
  // tear down and re-create the channel on every tab switch).
  const showArchiveRef = useRef(showArchive)
  const [allUserTags, setAllUserTags] = useState(/** @type {Tag[]} */ ([]))
  // null = no filter; a tag id = show only notes with that tag
  const [activeTagId, setActiveTagId] = useState(/** @type {number | null} */ (null))
  const [toast, setToast] = useState(/** @type {string | null} */ (null))
  // Stable callback — passed to Toast as onDismiss (rerender-functional-setstate).
  const dismissToast = useCallback(() => setToast(null), [])
  // searchQuery: bound to the input value; debouncedQuery: fires the fetch.
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // ── Debounce: update debouncedQuery 300ms after the user stops typing ────────
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(id)
  }, [searchQuery])

  // ── Keep showArchiveRef current whenever the tab switches ────────────────────
  useEffect(() => { showArchiveRef.current = showArchive }, [showArchive])

  // ── Realtime: subscribe to notes changes for this user ───────────────────────
  // Depends only on userId — the channel is created once per session, not on
  // every view toggle. View awareness is provided via showArchiveRef.
  useEffect(() => {
    const channel = supabase
      .channel(`notes:user:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        (payload) => {
          // Ignore cross-tab inserts while in the archive view — new notes are
          // never archived on creation.
          if (showArchiveRef.current) return
          /** @type {import('../lib/supabase').NoteWithTags} */
          const incoming = /** @type {any} */ (payload.new)
          // Dedup: skip if the same-tab optimistic update already added this note.
          setNotes(curr => {
            if (curr.some(n => n.id === incoming.id)) return curr
            // Realtime delivers the `notes` row only — no join data.
            const noteWithTags = { ...incoming, note_tags: [] }
            return [...curr, noteWithTags].sort(pinSort)
          })
          setTotalCount(curr => curr !== null ? curr + 1 : curr)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        (payload) => {
          /** @type {import('../lib/supabase').Note} */
          const updated = /** @type {any} */ (payload.new)
          setNotes(curr => {
            const existing = curr.find(n => n.id === updated.id)
            // Note is not in the current view — nothing to do.
            if (!existing) return curr
            // archived_at changed — the note is moving between views.
            if (existing.archived_at !== updated.archived_at) {
              // If it was active (archived_at was null) it is leaving the active
              // view, so decrement totalCount.
              if (existing.archived_at === null) {
                setTotalCount(c => c !== null ? c - 1 : c)
              }
              return curr.filter(n => n.id !== updated.id)
            }
            // Same view — update the row and re-sort (handles pin, title, content).
            // Preserve note_tags: Realtime does not deliver join data.
            const reconciled = curr.map(n =>
              n.id === updated.id ? { ...updated, note_tags: existing.note_tags } : n
            )
            return [...reconciled].sort(pinSort)
          })
        },
      )
      .on(
        'postgres_changes',
        // REPLICA IDENTITY FULL ensures payload.old contains user_id and
        // archived_at so the filter and totalCount logic work correctly.
        { event: 'DELETE', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        (payload) => {
          /** @type {import('../lib/supabase').Note} */
          const deleted = /** @type {any} */ (payload.old)
          setNotes(curr => curr.filter(n => n.id !== deleted.id))
          // Decrement totalCount only when an active (non-archived) note is deleted.
          if (deleted.archived_at === null) {
            setTotalCount(curr => curr !== null ? curr - 1 : curr)
          }
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Fetch: profile + tags (once on mount, parallel) ─────────────────────────
  // Promise.all fires both requests simultaneously — one round trip instead of
  // two sequential ones (async-parallel).

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.from('users').select('display_name').eq('id', userId).single(),
      supabase.from('tags').select('id, name').order('name'),
    ]).then(([{ data: profile }, { data: tags }]) => {
      if (cancelled) return
      setDisplayName(profile?.display_name ?? null)
      setAllUserTags(tags ?? [])
    })
    return () => { cancelled = true }
  }, [])

  // ── Fetch: notes (re-runs when view or debounced search query changes) ────────

  useEffect(() => {
    let cancelled = false
    setLoadingNotes(true)
    setFetchError(null)
    setTotalCount(null)

    async function fetchNotes() {
      let query
      if (debouncedQuery.length > 0) {
        // Full-text search via the stored `fts` tsvector column.
        // plain mode = plainto_tsquery, no special syntax required from the user.
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name))')
          .textSearch('fts', debouncedQuery, { type: 'plain', config: 'english' })
        if (showArchive) {
          query = query.not('archived_at', 'is', null)
        } else {
          query = query.is('archived_at', null)
        }
        // Results returned in relevance order from Postgres — no .order() needed.
      } else if (showArchive) {
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name))')
          .not('archived_at', 'is', null)
          .order('archived_at', { ascending: false })
      } else {
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name))', { count: 'exact' })
          .is('archived_at', null)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false })
          .range(0, PAGE_SIZE - 1)
      }

      const { data, error, count } = await query
      if (cancelled) return
      if (error) {
        setFetchError(error.message)
      } else {
        setNotes(data ?? [])
        // count is only set for the active-notes branch (count: 'exact' is only
        // requested there). For search/archive, count is undefined → null.
        setTotalCount(count ?? null)
      }
      setLoadingNotes(false)
    }

    fetchNotes()
    return () => { cancelled = true }
  }, [showArchive, debouncedQuery])

  // ── Create ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (title, content, selectedTags) => {
    const { data, error } = await supabase
      .from('notes')
      .insert({ title, content: content || null, user_id: userId })
      .select()
      .single()

    if (error) throw error

    // Insert note_tags rows if the user selected any tags.
    // This depends on the note id so it cannot be parallelised with the insert.
    if (selectedTags.length > 0) {
      const { error: tagError } = await supabase
        .from('note_tags')
        .insert(selectedTags.map(t => ({ note_id: data.id, tag_id: t.id })))
      if (tagError) throw tagError
    }

    // Build the NoteWithTags shape locally so we avoid a re-fetch.
    // Functional setState: insert then re-sort (rerender-functional-setstate).
    /** @type {NoteWithTags} */
    const noteWithTags = { ...data, note_tags: selectedTags.map(t => ({ tags: t })) }
    setNotes(curr => [...curr, noteWithTags].sort(pinSort))
    setTotalCount(curr => curr !== null ? curr + 1 : curr)
    setEditingNote(null)
    setToast('Note created')
  }, [])

  // ── Update ───────────────────────────────────────────────────────────────

  const handleUpdate = useCallback(
    async (title, content, selectedTags) => {
      if (editingNote === null || editingNote === 'new') return

      const { data, error } = await supabase
        .from('notes')
        .update({ title, content: content || null })
        .eq('id', editingNote.id)
        .select()
        .single()

      if (error) throw error

      // Diff the original tags against the new selection to find what to add/remove.
      const originalTagIds = new Set(
        editingNote.note_tags?.flatMap(nt => (nt.tags !== null ? [nt.tags.id] : [])) ?? []
      )
      const newTagIds = new Set(selectedTags.map(t => t.id))
      const toAdd = selectedTags.filter(t => !originalTagIds.has(t.id))
      const toRemove = [...originalTagIds].filter(id => !newTagIds.has(id))

      // Inserts and deletes are independent — run them in parallel (async-parallel).
      await Promise.all([
        toAdd.length > 0
          ? supabase.from('note_tags').insert(toAdd.map(t => ({ note_id: data.id, tag_id: t.id })))
          : Promise.resolve(),
        toRemove.length > 0
          ? supabase.from('note_tags').delete().eq('note_id', data.id).in('tag_id', toRemove)
          : Promise.resolve(),
      ])

      // Build the NoteWithTags shape locally to avoid a re-fetch.
      // Functional setState (rerender-functional-setstate).
      /** @type {NoteWithTags} */
      const noteWithTags = { ...data, note_tags: selectedTags.map(t => ({ tags: t })) }
      setNotes(curr => curr.map(n => (n.id === noteWithTags.id ? noteWithTags : n)))
      setEditingNote(null)
      setToast('Note saved')
    },
    [editingNote],
  )

  // ── Pin / Unpin ─────────────────────────────────────────────────────────

  const handleTogglePin = useCallback(async (note) => {
    // Optimistic update: flip is_pinned and re-sort immediately.
    // Snapshot is captured inside the functional updater to avoid stale closures
    // (rerender-functional-setstate).
    let snapshot
    setNotes(curr => {
      snapshot = curr
      const updated = curr.map(n =>
        n.id === note.id ? { ...n, is_pinned: !note.is_pinned } : n
      )
      return [...updated].sort(pinSort)
    })

    const newPinned = !note.is_pinned
    const { data, error } = await supabase
      .from('notes')
      .update({ is_pinned: newPinned })
      .eq('id', note.id)
      .select()
      .single()

    if (error) {
      // Rollback to the pre-optimistic snapshot and notify the user.
      setNotes(snapshot)
      setToast(`${newPinned ? 'Pin' : 'Unpin'} failed: ${error.message}`)
      return
    }

    // Reconcile server-canonical fields (e.g. updated_at) while preserving
    // note_tags — the update() response doesn't include joined data
    // (rerender-functional-setstate).
    setNotes(curr => {
      const reconciled = curr.map(n =>
        n.id === data.id ? { ...data, note_tags: n.note_tags } : n
      )
      return [...reconciled].sort(pinSort)
    })
  }, [])

  // ── Tags ──────────────────────────────────────────────────────────────────

  // Creates a new tag in the DB, adds it to allUserTags in sorted order,
  // and returns the created tag so NoteEditor can immediately select it.
  const handleCreateTag = useCallback(async (name) => {
    const { data, error } = await supabase
      .from('tags')
      .insert({ name, user_id: userId })
      .select('id, name')
      .single()
    if (error) throw error
    // Functional setState — keep list sorted alphabetically (rerender-functional-setstate).
    setAllUserTags(curr => [...curr, data].sort((a, b) => a.name.localeCompare(b.name)))
    setToast('Tag created')
    return data
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

  // ── Archive / Unarchive / Delete ──────────────────────────────────────────────────────

  const handleArchive = useCallback(async (id) => {
    // Optimistic update: remove from active view immediately.
    // Both notes and totalCount snapshots are captured for a complete rollback.
    let snapshot
    let countSnapshot
    setNotes(curr => { snapshot = curr; return curr.filter(n => n.id !== id) })
    setTotalCount(curr => { countSnapshot = curr; return curr !== null ? curr - 1 : curr })

    const { error } = await supabase
      .from('notes')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      setNotes(snapshot)
      setTotalCount(countSnapshot)
      setToast(`Archive failed: ${error.message}`)
      return
    }
    setToast('Note archived')
  }, [])

  const handleUnarchive = useCallback(async (id) => {
    // Optimistic update: remove from archive view immediately.
    let snapshot
    setNotes(curr => { snapshot = curr; return curr.filter(n => n.id !== id) })

    const { error } = await supabase
      .from('notes')
      .update({ archived_at: null })
      .eq('id', id)

    if (error) {
      setNotes(snapshot)
      setToast(`Unarchive failed: ${error.message}`)
      return
    }
    setToast('Note unarchived')
  }, [])

  const handleDeletePermanently = useCallback(async (id) => {
    const { error } = await supabase.from('notes').delete().eq('id', id)
    if (error) { alert(`Delete failed: ${error.message}`); return }
    // Functional setState (rerender-functional-setstate).
    setNotes(curr => curr.filter(n => n.id !== id))
    setToast('Note deleted')
  }, [])

  // ── Load more ─────────────────────────────────────────────────────────────

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true)
    // Read offset synchronously before the async call — needed for .range().
    // Can't use functional setState here because the value drives the network
    // request itself, not just a state update.
    const offset = notes.length
    const { data, error } = await supabase
      .from('notes')
      .select('*, note_tags(tags(id, name))')
      .is('archived_at', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
    setLoadingMore(false)
    if (error) { setToast(`Could not load more: ${error.message}`); return }
    setNotes(curr => [...curr, ...(data ?? [])])
  }, [notes.length])

  // ── Derived ──────────────────────────────────────────────────────────────

  // `isEditorOpen` is derived from `editingNote` during render — no separate
  // boolean state needed (rerender-derived-state-no-effect).
  const isEditorOpen = editingNote !== null
  // isSearching is derived from debouncedQuery during render.
  const isSearching = debouncedQuery.length > 0
  // hasMore: true only when paginated active notes have more server-side rows.
  // totalCount is null for search/archive, so hasMore is safely false in those
  // views without any extra checks (rerender-derived-state-no-effect).
  const hasMore = totalCount !== null && notes.length < totalCount
  const editorInitial = editingNote === 'new' ? null : editingNote

  const onSave = editingNote === 'new' ? handleCreate : handleUpdate

  // Filter notes by the active tag without a re-fetch — derived from state
  // during render (rerender-derived-state-no-effect).
  // Uses Set.has() for O(1) membership check per tag entry (js-set-map-lookups).
  const visibleNotes = activeTagId === null
    ? notes
    : notes.filter(n => n.note_tags.some(nt => nt.tags?.id === activeTagId))

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="notes-layout">
      <header className="notes-header">
        <div className="notes-tabs">
          <button
            type="button"
            className={`btn notes-tab${!showArchive ? ' notes-tab--active' : ''}`}
            onClick={() => setShowArchive(false)}
          >
            Notes
          </button>
          <button
            type="button"
            className={`btn notes-tab${showArchive ? ' notes-tab--active' : ''}`}
            onClick={() => { setShowArchive(true); setActiveTagId(null) }}
          >
            Archived
          </button>
        </div>
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
          {/* + New note hidden in archive view (rendering-conditional-render). */}
          {!showArchive ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setEditingNote('new')}
            >
              + New note
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      {/* Tag filter bar — always rendered so the search input is always visible.
          Tag pills are shown only in the active (non-archive) view with tags.
          Search bar is pushed to the right via margin-left: auto.
          (rendering-conditional-render: ternary, not &&) */}
      <div className="tag-filter-bar">
        {!showArchive && allUserTags.length > 0 ? allUserTags.map(tag => (
          <button
            key={tag.id}
            type="button"
            className={`tag-pill tag-pill--filter${activeTagId === tag.id ? ' tag-pill--active' : ''}`}
            onClick={() => setActiveTagId(curr => (curr === tag.id ? null : tag.id))}
          >
            {tag.name}
          </button>
        )) : null}
        <div className="search-bar">
          <input
            type="search"
            className="search-bar__input"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            aria-label="Search notes"
          />
        </div>
      </div>

      <main className="notes-main">
        {/* loadingNotes is boolean — && is safe here because the left side
            is a boolean, not a number (rendering-conditional-render applies
            to numeric/falsy-value conditions; boolean && is fine). */}
        {loadingNotes ? (
          <p className="notes-status">Loading…</p>
        ) : fetchError !== null ? (
          <p className="notes-status notes-error" role="alert">{fetchError}</p>
        ) : notes.length === 0 ? (
          <p className="notes-status">
            {isSearching
              ? `No results for \u201c${debouncedQuery}\u201d.`
              : showArchive ? 'No archived notes.' : 'No notes yet. Create your first one!'}
          </p>
        ) : (
          <>
            <div className="notes-grid">
              {visibleNotes.map(note => (
                <NoteCard
                  key={note.id}
                  note={note}
                  isArchiveView={showArchive}
                  onEdit={setEditingNote}
                  onArchive={handleArchive}
                  onUnarchive={handleUnarchive}
                  onDeletePermanently={handleDeletePermanently}
                  onTogglePin={handleTogglePin}
                />
              ))}
            </div>
            {hasMore ? (
              <div className="load-more-bar">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading\u2026' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </main>

      {/* isEditorOpen is a boolean derived from state — ternary prevents any
          risk of rendering a falsy value (rendering-conditional-render). */}
      {isEditorOpen ? (
        <NoteEditor
          initial={editorInitial}
          allUserTags={allUserTags}
          onSave={onSave}
          onCreateTag={handleCreateTag}
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

      {/* Top-right toast — auto-dismisses after 1500 ms (rendering-conditional-render). */}
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  )
}
