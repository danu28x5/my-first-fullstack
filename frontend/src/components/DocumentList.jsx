import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import DocumentEditor from './DocumentEditor'
import Toast from './Toast'
/** @typedef {import('../lib/supabase').Document} Document */

/**
 * Documents view — lists, creates, deletes, and opens a placeholder editor
 * for long-form Markdown documents. Follows the same data-flow and Realtime
 * patterns as NoteList.
 *
 * @param {{
 *   userId: string,
 *   onToast: (msg: string) => void,
 * }} props
 */
export default function DocumentList({ userId, onToast }) {
  const [documents, setDocuments] = useState(/** @type {Document[]} */ ([]))
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(/** @type {string | null} */ (null))
  // editingDoc: null = closed, Document = editing that document
  const [editingDoc, setEditingDoc] = useState(/** @type {Document | null} */ (null))

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
      onToast(`Create failed: ${error.message}`)
      return
    }

    // Register ID before await so Realtime handler skips the duplicate.
    optimisticInsertIds.current.add(data.id)

    // Prepend optimistically and open editor.
    setDocuments(curr => [data, ...curr])
    setEditingDoc(data)
    onToast('Document created')
  }, [userId, onToast])

  // ── Delete ──────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async (id) => {
    // Optimistic removal.
    let snapshot
    setDocuments(curr => { snapshot = curr; return curr.filter(d => d.id !== id) })

    const { error } = await supabase.from('documents').delete().eq('id', id)
    if (error) {
      setDocuments(snapshot)
      onToast(`Delete failed: ${error.message}`)
      return
    }
    onToast('Document deleted')
  }, [onToast])

  // ── Editor save handler ─────────────────────────────────────────────────

  const handleEditorSave = useCallback((/** @type {Document} */ saved) => {
    // Move saved doc to front (most recently modified).
    setDocuments(curr => {
      const next = curr.filter(d => d.id !== saved.id)
      return [saved, ...next]
    })
    setEditingDoc(null)
    onToast('Document saved')
  }, [onToast])

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
    <>
      <div className="doc-toolbar">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleCreate}
        >
          + New document
        </button>
      </div>

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
        <div className="notes-grid">
          {documents.map(doc => (
            <div
              key={doc.id}
              className="note-card doc-card"
              role="button"
              tabIndex={0}
              onClick={() => setEditingDoc(doc)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingDoc(doc) } }}
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
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingDoc !== null ? (
        <DocumentEditor
          key={editingDoc.id}
          document={editingDoc}
          onSave={handleEditorSave}
          onCancel={() => setEditingDoc(null)}
        />
      ) : null}
    </>
  )
}
