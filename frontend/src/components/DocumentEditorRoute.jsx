import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router'
import { supabase } from '../lib/supabase'
import DocumentEditor from './DocumentEditor'
/** @typedef {import('../lib/supabase').Document} Document */

/**
 * Route wrapper that fetches a document by its URL parameter and renders
 * the full DocumentEditor once loaded.
 *
 * Loading and error states are handled inline so the user sees feedback
 * immediately rather than a blank page.
 */
export default function DocumentEditorRoute() {
  const { documentId } = useParams()
  const [doc, setDoc] = useState(/** @type {Document | null} */ (null))
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
      } else {
        setDoc(data)
      }
      setLoading(false)
    }

    fetchDoc()
    return () => { cancelled = true }
  }, [documentId])

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

  return <DocumentEditor key={doc.id} document={doc} />
}
