import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import AvatarImage from './AvatarImage'
import Toast from './Toast'
/** @typedef {import('../lib/supabase').Document} Document */
/** @typedef {import('../lib/supabase').SharedDocumentRow} SharedDocumentRow */

/**
 * Documents view — lists, creates, deletes, and navigates to the document
 * editor. Follows the same data-flow and Realtime patterns as NoteList.
 *
 * @param {{ userId: string }} props
 */
export default function DocumentList({ userId }) {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState(/** @type {Document[]} */ ([]))
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(/** @type {string | null} */ (null))
  const [toast, setToast] = useState(/** @type {string | null} */ (null))
  // Stable callback — passed to Toast as onDismiss (rerender-functional-setstate).
  const dismissToast = useCallback(() => setToast(null), [])

  // Track IDs inserted by this tab so the Realtime INSERT handler can skip
  // them — prevents double-add race (same pattern as NoteList).
  const optimisticInsertIds = useRef(/** @type {Set<number>} */ (new Set()))

  // ── Shared documents state ──────────────────────────────────────────────
  const [sharedDocuments, setSharedDocuments] = useState(/** @type {SharedDocumentRow[]} */ ([]))
  const [sharedDocsLoading, setSharedDocsLoading] = useState(false)
  // ownerAvatarUrls: maps avatar_path → signed URL for doc owners in the shared section.
  const [ownerAvatarUrls, setOwnerAvatarUrls] = useState(/** @type {Map<string,string>} */ (new Map()))
  // Ref mirrors shared doc IDs for O(1) lookup in Realtime content-update
  // handler without including sharedDocuments in the dependency array.
  const sharedDocIdsRef = useRef(/** @type {Set<number>} */ (new Set()))

  // ── Fetch documents (most recently modified first) ──────────────────────

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFetchError(null)

    async function fetchDocs() {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })

      if (cancelled) return
      if (error) {
        setFetchError(error.message)
      } else {
        setDocuments(data ?? [])
      }
      setLoading(false)
    }

    fetchDocs()
    return () => { cancelled = true }
  }, [userId])

  // ── Realtime: subscribe to documents changes for this user ──────────────

  useEffect(() => {
    const channel = supabase
      .channel(`documents:user:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` },
        (payload) => {
          /** @type {Document} */
          const incoming = /** @type {any} */ (payload.new)
          // Same-tab optimistic insert — skip to avoid double-add.
          if (optimisticInsertIds.current.has(incoming.id)) {
            optimisticInsertIds.current.delete(incoming.id)
            return
          }
          // Cross-tab insert — prepend (most recent first by updated_at).
          setDocuments(curr => {
            if (curr.some(d => d.id === incoming.id)) return curr
            return [incoming, ...curr]
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` },
        (payload) => {
          /** @type {Document} */
          const updated = /** @type {any} */ (payload.new)
          setDocuments(curr => {
            const idx = curr.findIndex(d => d.id === updated.id)
            if (idx === -1) return curr
            // Move updated doc to front (most recently modified) and update.
            const next = curr.filter(d => d.id !== updated.id)
            return [updated, ...next]
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'documents', filter: `user_id=eq.${userId}` },
        (payload) => {
          /** @type {Document} */
          const deleted = /** @type {any} */ (payload.old)
          setDocuments(curr => curr.filter(d => d.id !== deleted.id))
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Fetch shared documents ──────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    setSharedDocsLoading(true)

    async function fetchSharedDocs() {
      const { data, error } = await supabase
        .from('document_shares')
        .select('id, document_id, owner_id, permission, created_at, documents(id, user_id, title, body, created_at, updated_at, users(display_name, avatar_path))')
        .eq('shared_with_user_id', userId)
        .order('created_at', { ascending: false })

      if (cancelled) return
      if (error) { setSharedDocsLoading(false); return }
      const rows = /** @type {SharedDocumentRow[]} */ (data ?? [])
      setSharedDocuments(rows)
      sharedDocIdsRef.current = new Set(rows.map(r => r.document_id))
      // Batch-resolve owner avatar signed URLs in parallel (async-parallel rule).
      const uniquePaths = [...new Set(rows.map(r => r.documents?.users?.avatar_path).filter(Boolean))]
      const urlEntries = await Promise.all(
        uniquePaths.map(async path => {
          const { data: u } = await supabase.storage.from('avatars').createSignedUrl(path, 3600)
          return /** @type {[string, string]} */ ([path, u?.signedUrl ?? ''])
        })
      )
      if (!cancelled) setOwnerAvatarUrls(new Map(urlEntries.filter(([, url]) => url)))
      setSharedDocsLoading(false)
    }

    fetchSharedDocs()
    return () => { cancelled = true }
  }, [userId])

  // ── Realtime: document_shares for this recipient ────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel(`document_shares:recipient:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'document_shares', filter: `shared_with_user_id=eq.${userId}` },
        async (payload) => {
          const incoming = /** @type {any} */ (payload.new)
          const { data } = await supabase
            .from('document_shares')
            .select('id, document_id, owner_id, permission, created_at, documents(id, user_id, title, body, created_at, updated_at, users(display_name, avatar_path))')
            .eq('id', incoming.id)
            .single()
          if (!data) return
          const row = /** @type {SharedDocumentRow} */ (/** @type {any} */ (data))
          // Resolve owner avatar signed URL for the new share.
          const avatarPath = row.documents?.users?.avatar_path
          if (avatarPath) {
            const { data: u } = await supabase.storage.from('avatars').createSignedUrl(avatarPath, 3600)
            if (u?.signedUrl) setOwnerAvatarUrls(prev => new Map([...prev, [avatarPath, u.signedUrl]]))
          }
          setSharedDocuments(curr => {
            if (curr.some(r => r.id === row.id)) return curr
            return [row, ...curr]
          })
          sharedDocIdsRef.current.add(row.document_id)
          setToast(`${row.documents?.users?.display_name ?? 'Someone'} shared a document with you`)
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'document_shares', filter: `shared_with_user_id=eq.${userId}` },
        (payload) => {
          const updated = /** @type {any} */ (payload.new)
          const docId = Number(updated.document_id)
          setSharedDocuments(curr => curr.map(r =>
            r.document_id === docId ? { ...r, permission: updated.permission } : r
          ))
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'document_shares', filter: `shared_with_user_id=eq.${userId}` },
        (payload) => {
          const deleted = /** @type {any} */ (payload.old)
          const docId = Number(deleted.document_id)
          setSharedDocuments(curr => curr.filter(r => r.document_id !== docId))
          sharedDocIdsRef.current.delete(docId)
        },
      )
      .on('broadcast', { event: 'doc_revoked' }, (payload) => {
        const docId = Number(payload.payload?.document_id)
        if (!docId) return
        setSharedDocuments(curr => curr.filter(r => r.document_id !== docId))
        sharedDocIdsRef.current.delete(docId)
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Realtime: content updates on documents shared with this user ────────

  useEffect(() => {
    const channel = supabase
      .channel(`documents:shared:${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'documents' },
        (payload) => {
          const updated = /** @type {any} */ (payload.new)
          if (!sharedDocIdsRef.current.has(updated.id)) return
          setSharedDocuments(curr => curr.map(r => {
            if (r.document_id !== updated.id) return r
            const existing = r.documents
            return { ...r, documents: existing ? { ...updated, users: existing.users } : null }
          }))
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // ── Create ──────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    const { data, error } = await supabase
      .from('documents')
      .insert({ title: 'Untitled document', body: null, user_id: userId })
      .select()
      .single()

    if (error) {
      setToast(`Create failed: ${error.message}`)
      return
    }

    // Register ID before await so Realtime handler skips the duplicate.
    optimisticInsertIds.current.add(data.id)

    // Prepend optimistically and navigate to editor.
    setDocuments(curr => [data, ...curr])
    navigate(`/documents/${data.id}`)
    setToast('Document created')
  }, [userId, navigate])

  // ── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id) => {
    // Optimistic removal.
    let snapshot
    setDocuments(curr => { snapshot = curr; return curr.filter(d => d.id !== id) })

    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) {
      setDocuments(snapshot)
      setToast(`Delete failed: ${error.message}`)
      return
    }
    setToast('Document deleted')
  }, [])

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Truncate body to ~120 chars for card preview. */
  function bodyPreview(/** @type {string | null} */ body) {
    if (!body) return ''
    return body.length > 120 ? body.slice(0, 120) + '…' : body
  }

  function formatDate(/** @type {string} */ iso) {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <main className="notes-main">
      {loading ? (
        <p className="notes-status">Loading…</p>
      ) : fetchError !== null ? (
        <p className="notes-status notes-error" role="alert">{fetchError}</p>
      ) : documents.length === 0 ? (
        <div className="notes-empty">
          <p className="notes-empty__title">No documents yet</p>
          <p className="notes-empty__body">Create your first Markdown document to get started.</p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleCreate}
          >
            + New document
          </button>
        </div>
      ) : (
        <>
          <p className="notes-doc-count">
            {documents.length === 1 ? '1 document' : `${documents.length} documents`}
          </p>
          <div className="notes-grid">
          {documents.map(doc => (
            <div
              key={doc.id}
              className="note-card doc-card"
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/documents/${doc.id}`)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/documents/${doc.id}`) } }}
            >
              <div className="note-card-body">
                <h3 className="note-card-title">{doc.title}</h3>
                {doc.body ? (
                  <p className="note-card-content">{bodyPreview(doc.body)}</p>
                ) : null}
              </div>
              <div className="note-card-footer">
                <span className="note-card-date">{formatDate(doc.updated_at)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon doc-delete-btn"
                  aria-label="Delete document"
                  onClick={e => { e.stopPropagation(); handleDelete(doc.id) }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
            <button
              type="button"
              className="doc-new-card"
              onClick={handleCreate}
              aria-label="Create new document"
            >
              <span className="doc-new-card__icon">+</span>
              <span className="doc-new-card__label">New document</span>
            </button>
          </div>
        </>
      )}

      {/* ── Shared with me ──────────────────────────────────────────── */}
      {sharedDocsLoading ? (
        <p className="notes-status">Loading shared documents…</p>
      ) : sharedDocuments.length > 0 ? (
        <>
          <h2 className="notes-section-heading">Shared with me</h2>
          <div className="notes-grid">
            {sharedDocuments.map(row => {
              const d = row.documents
              if (!d) return null
              const avatarUrl = d.users?.avatar_path
                ? (ownerAvatarUrls.get(d.users.avatar_path) ?? null)
                : null
              return (
                <div
                  key={row.id}
                  className={`note-card doc-card note-card--shared-view`}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/documents/${d.id}`)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/documents/${d.id}`) } }}
                >
                  {/* "Shared by" strip — mirrors NoteCard's owner strip */}
                  <div className="note-card-owner-info">
                    <AvatarImage
                      key={avatarUrl}
                      signedUrl={avatarUrl}
                      displayName={d.users?.display_name ?? null}
                      email={null}
                      size="sm"
                    />
                    <span className="note-card-owner-label">
                      Shared by {d.users?.display_name ?? 'Unknown'}
                    </span>
                    <span className="note-card-perm-badge">
                      {row.permission === 'edit' ? 'Editor' : 'Viewer'}
                    </span>
                  </div>
                  <div className="note-card-body">
                    <h3 className="note-card-title">{d.title}</h3>
                    {d.body ? (
                      <p className="note-card-content">{bodyPreview(d.body)}</p>
                    ) : null}
                  </div>
                  <div className="note-card-footer">
                    <span className="note-card-date">{formatDate(d.updated_at)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      <Toast message={toast} onDismiss={dismissToast} />
    </main>
  )
}
