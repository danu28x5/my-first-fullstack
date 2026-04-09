import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

/** @typedef {import('../lib/supabase').SharePermission} SharePermission */
/** @typedef {import('../lib/supabase').DocSharePanelRow}  DocSharePanelRow  */

/**
 * Modal that lets the document owner:
 *  - Look up a user by email and share the document with view or edit permission.
 *  - See who the document is already shared with, change permission, or revoke.
 *
 * Realtime: subscribes to document_shares INSERT/UPDATE/DELETE filtered by
 * document_id so the panel stays live across devices/tabs.
 *
 * Mirrors SharePanel.jsx (note sharing) with s/note/document/ changes.
 *
 * @param {{
 *   documentId:    number,
 *   documentTitle: string,
 *   userId:        string,
 *   onClose:       () => void,
 *   onToast:       (msg: string) => void,
 * }} props
 */
export default function DocumentSharePanel({ documentId, documentTitle, userId, onClose, onToast }) {
  const [emailInput, setEmailInput]   = useState('')
  const [permission, setPermission]   = useState(/** @type {SharePermission} */ ('view'))
  const [pending, setPending]         = useState(false)
  const [shareError, setShareError]   = useState(/** @type {string | null} */ (null))
  const [confirming, setConfirming]   = useState(
    /** @type {{ userId: string; displayName: string | null } | null} */ (null)
  )
  const [shares, setShares]           = useState(/** @type {DocSharePanelRow[]} */ ([]))
  const [sharesLoading, setSharesLoading] = useState(true)

  // ── Load existing shares ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function fetchShares() {
      const { data, error } = await supabase
        .from('document_shares')
        .select('id, shared_with_user_id, permission, created_at, users!document_shares_shared_with_user_id_fkey(display_name)')
        .eq('document_id', documentId)
        .eq('owner_id', userId)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (!error) setShares(/** @type {any} */ (data) ?? [])
      setSharesLoading(false)
    }
    fetchShares()
    return () => { cancelled = true }
  }, [documentId, userId])

  // ── Realtime: keep the panel live across devices/tabs ──────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`document_shares:panel:${documentId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'document_shares',
          filter: `document_id=eq.${documentId}`,
        },
        async (payload) => {
          const incoming = /** @type {any} */ (payload.new)
          setShares(curr => {
            if (curr.some(s => s.id === incoming.id)) return curr
            supabase
              .from('users')
              .select('display_name')
              .eq('id', incoming.shared_with_user_id)
              .single()
              .then(({ data }) => {
                setShares(prev => prev.map(s =>
                  s.id === incoming.id ? { ...s, users: data ?? null } : s
                ))
              })
            return [
              ...curr,
              {
                id: incoming.id,
                shared_with_user_id: incoming.shared_with_user_id,
                permission: incoming.permission,
                created_at: incoming.created_at,
                users: null,
              },
            ]
          })
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'document_shares',
          filter: `document_id=eq.${documentId}`,
        },
        (payload) => {
          const updated = /** @type {any} */ (payload.new)
          setShares(curr => curr.map(s =>
            s.id === updated.id ? { ...s, permission: updated.permission } : s
          ))
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'document_shares',
          filter: `document_id=eq.${documentId}`,
        },
        (payload) => {
          const deleted = /** @type {any} */ (payload.old)
          setShares(curr => curr.filter(s => s.id !== Number(deleted.id)))
        },
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [documentId])

  // ── Find user by email ─────────────────────────────────────────────────
  async function handleFind(e) {
    e.preventDefault()
    setShareError(null)
    setConfirming(null)
    const trimmed = emailInput.trim().toLowerCase()
    if (!trimmed) return

    setPending(true)
    try {
      const { data, error } = await supabase
        .rpc('find_user_for_share', { p_email: trimmed })
      if (error) throw error
      if (!data || data.length === 0) {
        setShareError('No account found for that email address.')
        return
      }
      const found = data[0]
      if (found.user_id === userId) {
        setShareError('You cannot share a document with yourself.')
        return
      }
      if (shares.some(s => s.shared_with_user_id === found.user_id)) {
        setShareError('This document is already shared with that user.')
        return
      }
      setConfirming({ userId: found.user_id, displayName: found.display_name })
    } catch (err) {
      setShareError(err.message ?? 'Lookup failed.')
    } finally {
      setPending(false)
    }
  }

  // ── Confirm share ──────────────────────────────────────────────────────
  async function handleShare() {
    if (!confirming) return
    setShareError(null)
    setPending(true)
    try {
      const { data, error } = await supabase
        .from('document_shares')
        .insert({
          document_id:         documentId,
          owner_id:            userId,
          shared_with_user_id: confirming.userId,
          permission,
        })
        .select('id, shared_with_user_id, permission, created_at')
        .single()
      if (error) throw error

      setShares(curr => [
        ...curr,
        {
          ...data,
          users: { display_name: confirming.displayName },
        },
      ])
      setConfirming(null)
      setEmailInput('')
      onToast(`Shared with ${confirming.displayName ?? confirming.userId}`)
    } catch (err) {
      setShareError(err.message ?? 'Share failed.')
    } finally {
      setPending(false)
    }
  }

  // ── Update permission ────────────────────────────────────────────────
  async function handleUpdatePermission(shareId, newPermission) {
    let snapshot
    setShares(curr => {
      snapshot = curr
      return curr.map(s => s.id === shareId ? { ...s, permission: newPermission } : s)
    })

    const { data, error } = await supabase
      .from('document_shares')
      .update({ permission: newPermission })
      .eq('id', shareId)
      .select('id')

    if (error || !data || data.length === 0) {
      setShares(snapshot)
      setShareError(error?.message ?? 'Permission update failed.')
    }
  }

  // ── Revoke share ───────────────────────────────────────────────────────
  async function handleRevoke(shareId, displayName) {
    const revokedUserId = shares.find(s => s.id === shareId)?.shared_with_user_id ?? null

    let snapshot
    setShares(curr => { snapshot = curr; return curr.filter(s => s.id !== shareId) })

    const { error } = await supabase
      .from('document_shares')
      .delete()
      .eq('id', shareId)

    if (error) {
      setShares(snapshot)
      setShareError(`Revoke failed: ${error.message}`)
      return
    }

    // Broadcast the revocation to the recipient's channel so their
    // "Shared with me" section updates immediately.
    if (revokedUserId) {
      const bc = supabase.channel(`document_shares:recipient:${revokedUserId}`)
      bc.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          bc.send({
            type: 'broadcast',
            event: 'doc_revoked',
            payload: { document_id: documentId },
          }).finally(() => supabase.removeChannel(bc))
        }
      })
    }

    onToast(`Removed ${displayName ?? 'user'}'s access`)
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={`Share "${documentTitle}"`}>
      <div className="editor-card share-panel">
        <h2 className="editor-heading">Share document</h2>
        <p className="share-panel__note-title">{documentTitle}</p>

        {confirming === null ? (
          <form onSubmit={handleFind} className="share-panel__form">
            <div className="field">
              <label htmlFor="share-doc-email">Recipient email</label>
              <input
                id="share-doc-email"
                type="email"
                placeholder="colleague@example.com"
                value={emailInput}
                onChange={e => setEmailInput(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="share-doc-permission">Access level</label>
              <select
                id="share-doc-permission"
                value={permission}
                onChange={e => setPermission(/** @type {SharePermission} */ (e.target.value))}
                className="share-panel__select"
              >
                <option value="view">View only</option>
                <option value="edit">Can edit</option>
              </select>
            </div>
            {shareError !== null ? (
              <p className="editor-error" role="alert">{shareError}</p>
            ) : null}
            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
                disabled={pending}
              >
                Close
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pending || emailInput.trim().length === 0}
              >
                {pending ? 'Looking up…' : 'Continue'}
              </button>
            </div>
          </form>
        ) : (
          <div className="share-panel__confirm">
            <p className="share-panel__confirm-text">
              Share this document with{' '}
              <strong>{confirming.displayName ?? confirming.userId}</strong>
              {' '}as{' '}
              <strong>{permission === 'edit' ? 'editor' : 'viewer'}</strong>?
            </p>
            {shareError !== null ? (
              <p className="editor-error" role="alert">{shareError}</p>
            ) : null}
            <div className="editor-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setConfirming(null); setShareError(null) }}
                disabled={pending}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleShare}
                disabled={pending}
              >
                {pending ? 'Sharing…' : 'Share'}
              </button>
            </div>
          </div>
        )}

        {sharesLoading ? (
          <p className="share-panel__shares-empty">Loading…</p>
        ) : shares.length === 0 ? (
          <p className="share-panel__shares-empty">Not shared with anyone yet.</p>
        ) : (
          <ul className="share-panel__shares-list" aria-label="People with access">
            {shares.map(s => (
              <li key={s.id} className="share-panel__share-row">
                <span className="share-panel__share-name">
                  {s.users?.display_name ?? s.shared_with_user_id}
                </span>
                <select
                  className="share-panel__select share-panel__perm-select"
                  value={s.permission}
                  aria-label={`Permission for ${s.users?.display_name ?? 'user'}`}
                  onChange={e => handleUpdatePermission(s.id, /** @type {SharePermission} */ (e.target.value))}
                >
                  <option value="view">Viewer</option>
                  <option value="edit">Editor</option>
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm share-panel__revoke-btn"
                  onClick={() => handleRevoke(s.id, s.users?.display_name ?? null)}
                  aria-label={`Remove ${s.users?.display_name ?? 'user'}'s access`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
