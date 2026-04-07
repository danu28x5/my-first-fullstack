import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import Toast from './Toast'
/** @typedef {import('../lib/supabase').Document} Document */

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

      <Toast message={toast} onDismiss={dismissToast} />
    </main>
  )
}
