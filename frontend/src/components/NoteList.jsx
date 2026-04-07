import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import AvatarImage from './AvatarImage'
import NoteCard from './NoteCard'
import NoteEditor from './NoteEditor'
import ProfileEditor from './ProfileEditor'
import SharePanel from './SharePanel'
import Toast from './Toast'
// JSDoc-only typedef imports — no runtime cost.
/** @typedef {import('../lib/supabase').NoteWithTags} NoteWithTags */
/** @typedef {import('../lib/supabase').Tag} Tag */
/** @typedef {import('../lib/supabase').NoteAttachmentPreview} NoteAttachmentPreview */
/** @typedef {import('../lib/supabase').SharedNoteRow} SharedNoteRow */
/** @typedef {import('../lib/supabase').SharePermission} SharePermission */

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
  // activeView replaces the old showArchive: boolean.
  //   'notes'    → active notes (was !showArchive)
  //   'archived' → archived notes (was showArchive)
  //   'shared'   → notes shared with this user by others
  const [totalCount, setTotalCount] = useState(/** @type {number | null} */ (null))
  const [loadingMore, setLoadingMore] = useState(false)
  // editingNote: null  → editor hidden
  //              'new' → creating a new note
  //              Note  → editing that note
  const [editingNote, setEditingNote] = useState(
    /** @type {import('../lib/supabase').Note | 'new' | null} */ (null),
  )
  const [displayName, setDisplayName] = useState(/** @type {string | null} */ (null))
  // avatarPath: the raw storage path stored in the DB (e.g. "uuid/avatar.png").
  // avatarSignedUrl: a time-limited signed URL generated from that path at
  // display time — never persisted to the database.
  const [avatarPath, setAvatarPath] = useState(/** @type {string | null} */ (null))
  const [avatarSignedUrl, setAvatarSignedUrl] = useState(/** @type {string | null} */ (null))
  const [profileEditorOpen, setProfileEditorOpen] = useState(false)
  // activeView replaces the old showArchive boolean — three-state navigation.
  const [activeView, setActiveView] = useState(/** @type {'notes'|'archived'|'shared'} */ ('notes'))
  // Ref mirrors activeView so the stable Realtime handler can read the current
  // view without needing activeView in its dependency array (which would
  // tear down and re-create the channel on every tab switch).
  const activeViewRef = useRef(activeView)
  // Ref mirrors totalCount so handleTogglePin can read the current count
  // without it being a dependency of the callback (same pattern as activeViewRef).
  const totalCountRef = useRef(/** @type {number | null} */ (null))
  // Tracks IDs inserted by this tab so the Realtime INSERT handler can skip
  // them — prevents the double-add / double-totalCount-increment race condition
  // where the Realtime event fires while handleCreate is awaiting Promise.all.
  const optimisticInsertIds = useRef(/** @type {Set<string>} */ (new Set()))
  const [allUserTags, setAllUserTags] = useState(/** @type {Tag[]} */ ([]))
  // null = no filter; a tag id = show only notes with that tag
  const [activeTagId, setActiveTagId] = useState(/** @type {number | null} */ (null))
  const [toast, setToast] = useState(/** @type {string | null} */ (null))
  // Stable callback — passed to Toast as onDismiss (rerender-functional-setstate).
  const dismissToast = useCallback(() => setToast(null), [])
  // searchQuery: bound to the input value; debouncedQuery: fires the fetch.
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // ── Shared notes state ───────────────────────────────────────────────────
  const [sharedNotes, setSharedNotes] = useState(/** @type {SharedNoteRow[]} */ ([]))
  const [sharedNotesLoading, setSharedNotesLoading] = useState(false)
  // ownerAvatarUrls: maps avatar_path → signed URL for note owners in the shared view.
  const [ownerAvatarUrls, setOwnerAvatarUrls] = useState(/** @type {Map<string,string>} */ (new Map()))
  // sharePanelNote: which owner note currently has the SharePanel open.
  const [sharePanelNote, setSharePanelNote] = useState(/** @type {NoteWithTags | null} */ (null))
  // Ref mirrors sharedNotes' note IDs for O(1) lookup in the Realtime UPDATE
  // handler without including sharedNotes in its dependency array.
  // (same pattern as activeViewRef / showArchiveRef in existing code)
  const sharedNoteIdsRef = useRef(/** @type {Set<number>} */ (new Set()))

  // ── Debounce: update debouncedQuery 300ms after the user stops typing ────────
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 300)
    return () => clearTimeout(id)
  }, [searchQuery])

  // ── Keep activeViewRef / totalCountRef current ──────────────────────────────
  useEffect(() => { activeViewRef.current = activeView }, [activeView])
  useEffect(() => { totalCountRef.current = totalCount }, [totalCount])

  // ── Realtime: subscribe to notes changes for this user ───────────────────────
  // Depends only on userId — the channel is created once per session, not on
  // every view toggle. View awareness is provided via activeViewRef.
  useEffect(() => {
    const channel = supabase
      .channel(`notes:user:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` },
        (payload) => {
          // Ignore cross-tab inserts while not in the notes view — new notes are
          // never archived on creation and don't belong in the shared view.
          if (activeViewRef.current !== 'notes') return
          /** @type {import('../lib/supabase').NoteWithTags} */
          const incoming = /** @type {any} */ (payload.new)
          // Same-tab optimistic insert: handleCreate registered the ID in
          // optimisticInsertIds synchronously before its next await, so the
          // ref is always set before this Realtime macro-task fires.
          // Consuming (delete) the entry ensures a cross-tab second creation of
          // the same note still goes through on the next event.
          if (optimisticInsertIds.current.has(incoming.id)) {
            optimisticInsertIds.current.delete(incoming.id)
            return
          }
          // Cross-tab insert — add it and update the count.
          setNotes(curr => {
            if (curr.some(n => n.id === incoming.id)) return curr
            // Realtime delivers the `notes` row only — no join data.
            const noteWithTags = { ...incoming, note_tags: [], note_attachments: [] }
            setTotalCount(c => c !== null ? c + 1 : c)
            return [...curr, noteWithTags].sort(pinSort)
          })
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
            // Preserve note_tags and note_attachments: Realtime does not deliver join data.
            const reconciled = curr.map(n =>
              n.id === updated.id
                ? { ...updated, note_tags: existing.note_tags, note_attachments: existing.note_attachments }
                : n
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
      .on(
        'postgres_changes',
        // Filter by user_id so only this user's attachments are delivered.
        // REPLICA IDENTITY FULL on note_attachments ensures payload.old carries
        // note_id so the note can be located on DELETE.
        { event: 'INSERT', schema: 'public', table: 'note_attachments', filter: `user_id=eq.${userId}` },
        (payload) => {
          const attachment = /** @type {any} */ (payload.new)
          // Number() coerces WAL bigint payloads that may arrive as strings.
          const noteId = Number(attachment.note_id)
          setNotes(curr => curr.map(n => {
            if (n.id !== noteId) return n
            // Guard against same-tab double-add: handleAttachFile / handleCreate
            // already append optimistically before this Realtime event fires.
            // Number() normalises WAL string IDs ("42") against PostgREST number IDs (42).
            if (n.note_attachments.some(a => a.id === Number(attachment.id))) return n
            return { ...n, note_attachments: [...n.note_attachments, attachment] }
          }))
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'note_attachments', filter: `user_id=eq.${userId}` },
        (payload) => {
          const deleted = /** @type {any} */ (payload.old)
          const noteId = Number(deleted.note_id)
          // Number() fixes the WAL string→number type mismatch for bigint id columns
          // (same pattern used for note_id above and for note_shares DELETE).
          const deletedId = Number(deleted.id)
          setNotes(curr => curr.map(n =>
            n.id === noteId
              ? { ...n, note_attachments: n.note_attachments.filter(a => a.id !== deletedId) }
              : n
          ))
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Realtime Channel 1: note_shares rows for this recipient ─────────────────
  // Fires when someone shares a note with us (INSERT) or revokes (DELETE).
  // REPLICA IDENTITY FULL on note_shares ensures DELETE payload.old carries
  // shared_with_user_id so the server-side filter works.
  useEffect(() => {
    const channel = supabase
      .channel(`note_shares:recipient:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'note_shares', filter: `shared_with_user_id=eq.${userId}` },
        async (payload) => {
          const incoming = /** @type {any} */ (payload.new)
          // Fetch the full row with note + owner profile.
          const { data } = await supabase
            .from('note_shares')
            .select('id, note_id, owner_id, permission, created_at, notes(*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at), users(display_name, avatar_path))')
            .eq('id', incoming.id)
            .single()
          if (!data) return
          const row = /** @type {SharedNoteRow} */ (/** @type {any} */ (data))
          const avatarPath = row.notes?.users?.avatar_path
          if (avatarPath) {
            const { data: u } = await supabase.storage.from('avatars').createSignedUrl(avatarPath, 3600)
            if (u?.signedUrl) setOwnerAvatarUrls(prev => new Map([...prev, [avatarPath, u.signedUrl]]))
          }
          setSharedNotes(curr => {
            if (curr.some(r => r.id === row.id)) return curr
            return [row, ...curr]
          })
          sharedNoteIdsRef.current.add(row.note_id)
          // Notify the recipient that a new note has been shared with them.
          setToast(`${row.notes?.users?.display_name ?? 'Someone'} shared a note with you`)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'note_shares', filter: `shared_with_user_id=eq.${userId}` },
        (payload) => {
          const updated = /** @type {any} */ (payload.new)
          // Number() coerces WAL bigint payloads that may arrive as strings.
          const noteId = Number(updated.note_id)
          // Update the permission badge in place — no flash, no reorder.
          setSharedNotes(curr => curr.map(r =>
            r.note_id === noteId ? { ...r, permission: updated.permission } : r
          ))
        },
      )
      .on(
        'postgres_changes',
        // Server-side filter is applied against old_record for DELETE events —
        // REPLICA IDENTITY FULL makes all columns available in the WAL record,
        // so this filter drives event delivery to the recipient correctly.
        // The original removal was wrong: the real bug was a type mismatch —
        // WAL delivers bigint as a JS string ("42") while r.note_id from fetch
        // is a number (42), so "42" !== 42 meant the note was never removed.
        { event: 'DELETE', schema: 'public', table: 'note_shares', filter: `shared_with_user_id=eq.${userId}` },
        (payload) => {
          const deleted = /** @type {any} */ (payload.old)
          // Number() fixes the WAL string→number type mismatch for bigint columns.
          const noteId = Number(deleted.note_id)
          setSharedNotes(curr => curr.filter(r => r.note_id !== noteId))
          sharedNoteIdsRef.current.delete(noteId)
        },
      )
      .on('broadcast', { event: 'note_revoked' }, (payload) => {
        // Fired by SharePanel.handleRevoke after a successful hard-delete.
        // postgres_changes DELETE events are silently dropped for the recipient
        // because Supabase's RLS auth check runs against the live table — after
        // the delete the row is gone, the check finds nothing and fails, so the
        // event never reaches the client. Broadcast bypasses table-level RLS
        // entirely and is the reliable revocation signal.
        const noteId = Number(payload.payload?.note_id)
        if (!noteId) return
        setSharedNotes(curr => curr.filter(r => r.note_id !== noteId))
        sharedNoteIdsRef.current.delete(noteId)
      })
      .on('broadcast', { event: 'attachment_deleted' }, (payload) => {
        // Fired by NoteList.handleDeleteAttachment after a successful delete.
        // postgres_changes DELETE events are silently dropped for recipients
        // because Supabase's RLS auth check runs against the live table — the
        // row is already gone so the check fails. Broadcast bypasses RLS.
        const noteId = Number(payload.payload?.note_id)
        const attachmentId = Number(payload.payload?.attachment_id)
        if (!noteId || !attachmentId) return
        setSharedNotes(curr => curr.map(r => {
          if (r.note_id !== noteId) return r
          const existing = r.notes
          if (!existing) return r
          return { ...r, notes: { ...existing, note_attachments: existing.note_attachments.filter(a => a.id !== attachmentId) } }
        }))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Realtime Channel 2: content updates on notes shared with this user ───────
  // No server-side filter is possible (set is dynamic); gate client-side via
  // sharedNoteIdsRef — same stable-ref pattern as activeViewRef.
  useEffect(() => {
    const channel = supabase
      .channel(`notes:shared:${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'notes' },
        (payload) => {
          const updated = /** @type {any} */ (payload.new)
          if (!sharedNoteIdsRef.current.has(updated.id)) return
          setSharedNotes(curr => curr.map(r => {
            if (r.note_id !== updated.id) return r
            const existing = r.notes
            return { ...r, notes: existing ? { ...updated, note_tags: existing.note_tags, note_attachments: existing.note_attachments, users: existing.users } : null }
          }))
        },
      )
      .on(
        'postgres_changes',
        // No server-side filter — shared note IDs are a dynamic set.
        // Gate delivery client-side via sharedNoteIdsRef (same pattern as
        // the UPDATE handler above). RLS on note_attachments ensures only
        // rows the authenticated user may read are delivered.
        { event: 'INSERT', schema: 'public', table: 'note_attachments' },
        (payload) => {
          const attachment = /** @type {any} */ (payload.new)
          const noteId = Number(attachment.note_id)
          if (!sharedNoteIdsRef.current.has(noteId)) return
          setSharedNotes(curr => curr.map(r => {
            if (r.note_id !== noteId) return r
            const existing = r.notes
            if (!existing) return r
            // Guard against same-tab double-add (same pattern as own-notes INSERT handler).
            // Number() normalises WAL string IDs ("42") against PostgREST number IDs (42).
            if (existing.note_attachments.some(a => a.id === Number(attachment.id))) return r
            return { ...r, notes: { ...existing, note_attachments: [...existing.note_attachments, attachment] } }
          }))
        },
      )
      .on(
        'postgres_changes',
        // REPLICA IDENTITY FULL on note_attachments ensures payload.old
        // carries note_id so the entry can be located on DELETE.
        { event: 'DELETE', schema: 'public', table: 'note_attachments' },
        (payload) => {
          const deleted = /** @type {any} */ (payload.old)
          const noteId = Number(deleted.note_id)
          // Number() fixes the WAL string→number type mismatch for bigint id columns.
          const deletedId = Number(deleted.id)
          if (!sharedNoteIdsRef.current.has(noteId)) return
          setSharedNotes(curr => curr.map(r => {
            if (r.note_id !== noteId) return r
            const existing = r.notes
            if (!existing) return r
            return { ...r, notes: { ...existing, note_attachments: existing.note_attachments.filter(a => a.id !== deletedId) } }
          }))
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Fetch: profile + tags (once on mount, parallel) ─────────────────────────
  // Promise.all fires both requests simultaneously — one round trip instead of
  // two sequential ones (async-parallel). The signed URL fetch is sequential
  // because it depends on the avatar_path from the profile query
  // (async-defer-await: await only where the value is first needed).

  useEffect(() => {
    let cancelled = false
    async function fetchProfileAndTags() {
      const [{ data: profile }, { data: tags }] = await Promise.all([
        supabase.from('users').select('display_name, avatar_path').eq('id', userId).single(),
        supabase.from('tags').select('id, name').order('name'),
      ])
      if (cancelled) return
      setDisplayName(profile?.display_name ?? null)
      setAllUserTags(tags ?? [])
      const path = profile?.avatar_path ?? null
      setAvatarPath(path)
      if (path) {
        const { data: urlData } = await supabase.storage
          .from('avatars')
          .createSignedUrl(path, 3600)
        if (!cancelled) setAvatarSignedUrl(urlData?.signedUrl ?? null)
      }
    }
    fetchProfileAndTags()
    return () => { cancelled = true }
  }, [])

  // ── Fetch: notes (re-runs when view or debounced search query changes) ────────

  useEffect(() => {
    // Don't fetch own notes while on the shared tab — a separate fetch handles that.
    if (activeView === 'shared') return
    let cancelled = false
    setLoadingNotes(true)
    setFetchError(null)
    setTotalCount(null)

    async function fetchNotes() {
      const isArchived = activeView === 'archived'
      let query
      if (debouncedQuery.length > 0) {
        // Full-text search via the stored `fts` tsvector column.
        // plain mode = plainto_tsquery, no special syntax required from the user.
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at)')
          .eq('user_id', userId)
          .textSearch('fts', debouncedQuery, { type: 'plain', config: 'english' })
        if (isArchived) {
          query = query.not('archived_at', 'is', null)
        } else {
          query = query.is('archived_at', null)
        }
        // Results returned in relevance order from Postgres — no .order() needed.
      } else if (isArchived) {
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at)')
          .eq('user_id', userId)
          .not('archived_at', 'is', null)
          .order('archived_at', { ascending: false })
      } else {
        query = supabase
          .from('notes')
          .select('*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at)', { count: 'exact' })
          .eq('user_id', userId)
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
  }, [activeView, debouncedQuery])

  // ── Fetch: shared notes ────────────────────────────────────────────────────
  // Extracted as useCallback so it can be called both when the 'shared' tab
  // activates and when the page regains visibility. Supabase Realtime's
  // RLS auth check for DELETE events queries the *live* table — after a hard
  // delete the row is gone, so the check fails and the event is never
  // delivered to the recipient. The visibilitychange refetch below catches
  // any revocations that occurred while the tab was backgrounded.
  const fetchSharedNotes = useCallback(async () => {
    setSharedNotesLoading(true)
    const { data, error } = await supabase
      .from('note_shares')
      .select('id, note_id, owner_id, permission, created_at, notes(*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at), users(display_name, avatar_path))')
      .eq('shared_with_user_id', userId)
      .order('created_at', { ascending: false })
    if (error) { setSharedNotesLoading(false); return }
    const rows = /** @type {SharedNoteRow[]} */ (data ?? [])
    setSharedNotes(rows)
    sharedNoteIdsRef.current = new Set(rows.map(r => r.note_id))
    // Batch-resolve owner avatar signed URLs in parallel (async-parallel rule).
    const uniquePaths = [...new Set(rows.map(r => r.notes?.users?.avatar_path).filter(Boolean))]
    const urlEntries = await Promise.all(
      uniquePaths.map(async path => {
        const { data: u } = await supabase.storage.from('avatars').createSignedUrl(path, 3600)
        return /** @type {[string, string]} */ ([path, u?.signedUrl ?? ''])
      })
    )
    setOwnerAvatarUrls(new Map(urlEntries.filter(([, url]) => url)))
    setSharedNotesLoading(false)
  }, [userId])

  // Runs when the 'shared' tab is activated.
  useEffect(() => {
    if (activeView !== 'shared') return
    fetchSharedNotes()
  }, [activeView, fetchSharedNotes])

  // Refetch when the page regains visibility so revocations that happened
  // while this tab was backgrounded are reflected immediately.
  // Uses activeViewRef (stable ref) to avoid re-registering on every tab
  // switch (same pattern as the Realtime handlers above).
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === 'visible' && activeViewRef.current === 'shared') {
        fetchSharedNotes()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => { document.removeEventListener('visibilitychange', handleVisibility) }
  }, [fetchSharedNotes])

  // ── Create ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (title, content, selectedTags, pendingFiles = []) => {
    const { data, error } = await supabase
      .from('notes')
      .insert({ title, content: content || null, user_id: userId })
      .select()
      .single()

    if (error) throw error

    // Register the new ID synchronously before the next await so the Realtime
    // INSERT handler (a macro-task) can detect this same-tab creation and skip
    // its duplicate-add logic.  The ref is always set before the WebSocket
    // event fires because JS delivers macro-tasks only after the microtask
    // queue drains, and await Promise.all (below) is still in this microtask.
    optimisticInsertIds.current.add(data.id)

    // Build file upload descriptors — paths are computed before the upload
    // so they are available for both the storage call and the metadata insert.
    const fileUploads = pendingFiles.map(file => {
      const safeName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${file.name}`
      const path = `${userId}/${data.id}/${safeName}`
      return { file, path }
    })

    // Tag inserts and file uploads are independent — run in parallel
    // (async-parallel rule: Promise.all for independent operations).
    const tagOp = selectedTags.length > 0
      ? supabase.from('note_tags').insert(selectedTags.map(t => ({ note_id: data.id, tag_id: t.id })))
      : Promise.resolve({ error: null })
    const uploadOps = fileUploads.map(({ file, path }) =>
      supabase.storage.from('attachments').upload(path, file, { contentType: file.type })
    )
    const [tagResult, ...uploadResults] = await Promise.all([tagOp, ...uploadOps])
    if (tagResult.error) throw tagResult.error
    const firstUploadError = uploadResults.find(r => r.error)?.error
    if (firstUploadError) throw firstUploadError

    // Insert metadata rows after all uploads succeed.
    let attachmentRows = []
    if (fileUploads.length > 0) {
      const { data: attData, error: attError } = await supabase
        .from('note_attachments')
        .insert(fileUploads.map(({ file, path }) => ({
          note_id: data.id,
          user_id: userId,
          storage_path: path,
          file_name: file.name,
          mime_type: file.type,
          byte_size: file.size,
        })))
        .select('id, file_name, storage_path, mime_type, byte_size, created_at')
      if (attError) throw attError
      attachmentRows = attData ?? []
    }

    // Build the NoteWithTags shape locally so we avoid a re-fetch.
    // Functional setState: insert then re-sort (rerender-functional-setstate).
    /** @type {NoteWithTags} */
    const noteWithTags = {
      ...data,
      note_tags: selectedTags.map(t => ({ tags: t })),
      note_attachments: attachmentRows,
    }
    setNotes(curr => [...curr, noteWithTags].sort(pinSort))
    setTotalCount(curr => curr !== null ? curr + 1 : curr)
    setEditingNote(null)
    setToast('Note created')
  }, [userId])

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
      // Preserve note_attachments from the current state — the update response
      // does not include joined data (rerender-functional-setstate).
      setNotes(curr => {
        const existing = curr.find(n => n.id === data.id)
        /** @type {NoteWithTags} */
        const noteWithTags = {
          ...data,
          note_tags: selectedTags.map(t => ({ tags: t })),
          note_attachments: existing?.note_attachments ?? [],
        }
        return curr.map(n => (n.id === noteWithTags.id ? noteWithTags : n))
      })
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
      // When unpinning while more pages exist on the server: if this note's
      // created_at is older than every other loaded note, it belongs beyond
      // the current page boundary — remove it so Load More fetches it from
      // the correct offset instead of duplicating it.
      if (note.is_pinned && totalCountRef.current !== null && curr.length < totalCountRef.current) {
        const others = curr.filter(n => n.id !== note.id)
        const sortedOthers = [...others].sort(pinSort)
        const oldestOther = sortedOthers.at(-1)
        if (oldestOther && note.created_at < oldestOther.created_at) {
          return sortedOthers
        }
      }
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
    // note_tags and note_attachments — the update() response doesn't include
    // joined data (rerender-functional-setstate).
    setNotes(curr => {
      const reconciled = curr.map(n =>
        n.id === data.id
          ? { ...data, note_tags: n.note_tags, note_attachments: n.note_attachments }
          : n
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
    setToast('Profile saved')
  }, [])

  // Called by ProfileEditor after a successful avatar upload + DB write.
  // Generates a fresh signed URL from the saved path and updates state so
  // the header avatar refreshes immediately (rerender-move-effect-to-event).
  const handleAvatarSave = useCallback(async (path) => {
    setAvatarPath(path)
    const { data } = await supabase.storage.from('avatars').createSignedUrl(path, 3600)
    setAvatarSignedUrl(data?.signedUrl ?? null)
  }, [])

  // ── Attachment: upload a file to an existing note ─────────────────────────

  // Generates a collision-safe storage path, uploads the file, inserts the
  // metadata row, then updates state optimistically so the attachment appears
  // in the editor immediately without a re-fetch.
  const handleAttachFile = useCallback(async (file) => {
    if (editingNote === null || editingNote === 'new') return
    const safeName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${file.name}`
    const path = `${userId}/${editingNote.id}/${safeName}`

    const { error: storageError } = await supabase.storage
      .from('attachments')
      .upload(path, file, { contentType: file.type })
    if (storageError) throw storageError

    const { data, error: dbError } = await supabase
      .from('note_attachments')
      .insert({
        note_id: editingNote.id,
        user_id: userId,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type,
        byte_size: file.size,
      })
      .select('id, file_name, storage_path, mime_type, byte_size, created_at')
      .single()
    if (dbError) throw dbError

    // Append to the note's attachment list in state (rerender-functional-setstate).
    setNotes(curr => curr.map(n =>
      n.id === editingNote.id
        ? { ...n, note_attachments: [...n.note_attachments, data] }
        : n
    ))
  }, [editingNote, userId])

  // ── Attachment: optimistic delete ────────────────────────────────────────

  // Removes the attachment from state immediately, then deletes the storage
  // object and the metadata row in parallel (async-parallel rule).  Rolls
  // back if either operation fails.
  const handleDeleteAttachment = useCallback(async (attachment) => {
    if (editingNote === null || editingNote === 'new') return
    const noteId = editingNote.id

    let snapshot
    setNotes(curr => {
      snapshot = curr
      return curr.map(n =>
        n.id === noteId
          ? { ...n, note_attachments: n.note_attachments.filter(a => a.id !== attachment.id) }
          : n
      )
    })

    // Storage removal and DB row deletion are independent — run in parallel
    // (async-parallel rule).
    const [storageResult, dbResult] = await Promise.all([
      supabase.storage.from('attachments').remove([attachment.storage_path]),
      supabase.from('note_attachments').delete().eq('id', attachment.id),
    ])

    if (storageResult.error || dbResult.error) {
      setNotes(snapshot)
      setToast(`Delete failed: ${storageResult.error?.message ?? dbResult.error?.message}`)
      return
    }

    // Broadcast attachment_deleted to all note recipients so their shared view
    // updates immediately. postgres_changes DELETE events are silently dropped
    // for recipients because Supabase's RLS auth check runs against the live
    // table — the row is already gone so the check fails and the event is
    // never delivered. Broadcast bypasses table-level RLS entirely.
    // Same pattern as SharePanel.handleRevoke → note_revoked.
    const { data: shares } = await supabase
      .from('note_shares')
      .select('shared_with_user_id')
      .eq('note_id', noteId)
    if (shares && shares.length > 0) {
      shares.forEach(s => {
        const bc = supabase.channel(`note_shares:recipient:${s.shared_with_user_id}`)
        bc.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            bc.send({
              type: 'broadcast',
              event: 'attachment_deleted',
              payload: { note_id: noteId, attachment_id: attachment.id },
            }).finally(() => supabase.removeChannel(bc))
          }
        })
      })
    }
  }, [editingNote])

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

  // ── Share panel ───────────────────────────────────────────────────────────

  const handleOpenSharePanel = useCallback((note) => {
    setSharePanelNote(note)
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
      .select('*, note_tags(tags(id, name)), note_attachments(id, file_name, storage_path, mime_type, byte_size, created_at)')
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
    setLoadingMore(false)
    if (error) { setToast(`Could not load more: ${error.message}`); return }
    setNotes(curr => {
      const existingIds = new Set(curr.map(n => n.id))
      return [...curr, ...(data ?? []).filter(n => !existingIds.has(n.id))]
    })
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
            className={`btn notes-tab${activeView === 'notes' ? ' notes-tab--active' : ''}`}
            onClick={() => setActiveView('notes')}
          >
            Notes
          </button>
          <button
            type="button"
            className={`btn notes-tab${activeView === 'archived' ? ' notes-tab--active' : ''}`}
            onClick={() => { setActiveView('archived'); setActiveTagId(null) }}
          >
            Archived
          </button>
          <button
            type="button"
            className={`btn notes-tab${activeView === 'shared' ? ' notes-tab--active' : ''}`}
            onClick={() => { setActiveView('shared'); setActiveTagId(null) }}
          >
            Shared with me
          </button>
        </div>
        <div className="notes-header-actions">
          {/* Avatar + name as a single profile button.
              key=avatarSignedUrl resets AvatarImage's imgError state when the
              URL changes — keyed-reset pattern avoids an effect for derived
              error state (rerender-derived-state-no-effect). */}
          <button
            type="button"
            className="btn btn-ghost notes-profile-btn"
            onClick={() => setProfileEditorOpen(true)}
            aria-label="Edit profile"
          >
            <AvatarImage
              key={avatarSignedUrl}
              signedUrl={avatarSignedUrl}
              displayName={displayName}
              email={userEmail}
              size="sm"
            />
            <span className="notes-user">{displayName ?? userEmail}</span>
          </button>
          {/* + New note only in the active notes view (rendering-conditional-render). */}
          {activeView === 'notes' ? (
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
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onToggleTheme}
            aria-label="Toggle day/night theme"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      {/* Tag filter bar — always rendered so the search input is always visible.
          Tag pills are shown only in the active (non-archive) view with tags.
          Search bar is pushed to the right via margin-left: auto.
          (rendering-conditional-render: ternary, not &&) */}
      <div className="tag-filter-bar">
        {activeView === 'notes' && allUserTags.length > 0 ? allUserTags.map(tag => (
          <button
            key={tag.id}
            type="button"
            className={`tag-pill tag-pill--filter${activeTagId === tag.id ? ' tag-pill--active' : ''}`}
            onClick={() => setActiveTagId(curr => (curr === tag.id ? null : tag.id))}
          >
            {tag.name}
          </button>
        )) : null}
      </div>

      <main className="notes-main">
        <div className="notes-search-row">
          <div className="notes-search-input-wrap">
            <svg className="notes-search-row__icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              className="notes-search-input"
              placeholder="Search notes..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              aria-label="Search notes"
            />
          </div>
          {isSearching && !loadingNotes && activeView !== 'shared' ? (
            <p className="notes-search-hint">
              {visibleNotes.length === 1 ? '1 note found' : `${visibleNotes.length} notes found`}
            </p>
          ) : null}
        </div>
        {activeView === 'shared' ? (
          /* ── Shared with me view ─────────────────────────────────────── */
          sharedNotesLoading ? (
            <p className="notes-status">Loading…</p>
          ) : sharedNotes.length === 0 ? (
            <div className="notes-empty">
              <p className="notes-empty__title">No shared notes yet</p>
              <p className="notes-empty__body">When someone shares a note with you, it will appear here.</p>
            </div>
          ) : (
            <div className="notes-grid">
              {sharedNotes.map(row => {
                const note = row.notes
                if (!note) return null
                const avatarUrl = note.users?.avatar_path
                  ? (ownerAvatarUrls.get(note.users.avatar_path) ?? null)
                  : null
                return (
                  <NoteCard
                    key={row.id}
                    note={note}
                    isArchiveView={false}
                    isSharedView
                    permission={row.permission}
                    ownerInfo={note.users ? { displayName: note.users.display_name, avatarSignedUrl: avatarUrl } : null}
                    onEdit={row.permission === 'edit' ? setEditingNote : undefined}
                    onArchive={undefined}
                    onUnarchive={undefined}
                    onDeletePermanently={undefined}
                    onTogglePin={undefined}
                    onShare={undefined}
                  />
                )
              })}
            </div>
          )
        ) : (
          /* ── Own notes / archived view ───────────────────────────────── */
          /* loadingNotes is boolean — && is safe here because the left side
             is a boolean, not a number (rendering-conditional-render applies
             to numeric/falsy-value conditions; boolean && is fine). */
          loadingNotes ? (
            <p className="notes-status">Loading…</p>
          ) : fetchError !== null ? (
            <p className="notes-status notes-error" role="alert">{fetchError}</p>
          ) : notes.length === 0 ? (
            isSearching ? (
              <div className="notes-empty">
                <p className="notes-empty__title">No results</p>
                <p className="notes-empty__body">No notes matched “{debouncedQuery}”. Try a different search.</p>
              </div>
            ) : activeView === 'archived' ? (
              <div className="notes-empty">
                <p className="notes-empty__title">No archived notes</p>
                <p className="notes-empty__body">Notes you archive will appear here.</p>
              </div>
            ) : (
              <div className="notes-empty">
                <p className="notes-empty__title">Your notebook is empty</p>
                <p className="notes-empty__body">Get started by creating your first note.</p>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditingNote('new')}
                >
                  + New note
                </button>
              </div>
            )
          ) : (
            <>
              <div className="notes-grid">
                {visibleNotes.map(note => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    isArchiveView={activeView === 'archived'}
                    isSharedView={false}
                    permission={null}
                    ownerInfo={null}
                    onEdit={setEditingNote}
                    onArchive={handleArchive}
                    onUnarchive={handleUnarchive}
                    onDeletePermanently={handleDeletePermanently}
                    onTogglePin={handleTogglePin}
                    onShare={handleOpenSharePanel}
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
                    {loadingMore ? 'Loading…' : `Load more (${totalCount !== null ? totalCount - notes.length : '…'} remaining)`}
                  </button>
                </div>
              ) : null}
            </>
          )
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
          noteId={editingNote === 'new' ? null : editingNote?.id ?? null}
          noteAttachments={editingNote === 'new' || editingNote === null
            ? []
            : (notes.find(n => n.id === editingNote.id)?.note_attachments ?? [])}
          onAttachFile={handleAttachFile}
          onDeleteAttachment={handleDeleteAttachment}
        />
      ) : null}
      {sharePanelNote !== null ? (
        <SharePanel
          noteId={sharePanelNote.id}
          noteTitle={sharePanelNote.title}
          userId={userId}
          onClose={() => setSharePanelNote(null)}
          onToast={setToast}
        />
      ) : null}
      {profileEditorOpen ? (
        <ProfileEditor
          initialName={displayName ?? userEmail ?? ''}
          userId={userId}
          initialAvatarSignedUrl={avatarSignedUrl}
          onSave={handleProfileSave}
          onAvatarSave={handleAvatarSave}
          onCancel={() => setProfileEditorOpen(false)}
        />
      ) : null}

      {/* Top-right toast — auto-dismisses after 1500 ms (rendering-conditional-render). */}
      <Toast message={toast} onDismiss={dismissToast} />
    </div>
  )
}
