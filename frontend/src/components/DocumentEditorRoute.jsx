import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import DocumentEditor from './DocumentEditor'
/** @typedef {import('../lib/supabase').Document} Document */
/** @typedef {import('../lib/supabase').SharePermission} SharePermission */

/**
 * Route wrapper that fetches a document by its URL parameter and renders
 * the full DocumentEditor once loaded.
 *
 * Loading and error states are handled inline so the user sees feedback
 * immediately rather than a blank page.
 *
 * @param {{ userId: string }} props
 */
export default function DocumentEditorRoute({ userId }) {
  const { documentId } = useParams()
  const navigate = useNavigate()
  const [doc, setDoc] = useState(/** @type {Document | null} */ (null))
  const [permission, setPermission] = useState(/** @type {SharePermission | null} */ (null))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(/** @type {string | null} */ (null))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchDoc() {
      const { data, error: fetchErr } = await supabase
        .from('documents')
        .select('*')
        .eq('id', documentId)
        .single()

      if (cancelled) return
      if (fetchErr) {
        setError(fetchErr.message)
        setLoading(false)
        return
      }

      setDoc(data)

      // If not the owner, fetch the share row to determine permission
      if (data.user_id !== userId) {
        const { data: share } = await supabase
          .from('document_shares')
          .select('permission')
          .eq('document_id', data.id)
          .eq('shared_with_user_id', userId)
          .single()

        if (cancelled) return
        setPermission(share?.permission ?? null)
      }

      setLoading(false)
    }

    fetchDoc()
    return () => { cancelled = true }
  }, [documentId, userId])

  // Listen for revocation while viewing a shared document
  useEffect(() => {
    if (!doc || doc.user_id === userId) return

    const channel = supabase.channel(`document_shares:recipient:${userId}`)
      .on('broadcast', { event: 'doc_revoked' }, (payload) => {
        if (String(payload.payload?.document_id) === String(doc.id)) {
          navigate('/documents', { replace: true })
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [doc, userId, navigate])

  if (loading) {
    return <p className="notes-status">Loading document…</p>
  }

  if (error || !doc) {
    return (
      <div className="notes-empty">
        <p className="notes-empty__title">Document not found</p>
        <p className="notes-empty__body">{error ?? 'This document may have been deleted.'}</p>
        <Link to="/documents" className="btn btn-secondary">
          ← Back to documents
        </Link>
      </div>
    )
  }

  const isOwner = doc.user_id === userId

  return (
    <DocumentEditor
      key={doc.id}
      document={doc}
      userId={userId}
      isOwner={isOwner}
      permission={permission}
    />
  )
}
