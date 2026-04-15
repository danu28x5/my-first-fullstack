import { useCallback, useEffect, useRef, useState, useDeferredValue } from 'react'
import { useNavigate } from 'react-router'
import * as Y from 'yjs'
import { supabase } from '../lib/supabase'
import { toBase64, fromBase64 } from '../lib/base64'
import { SupabaseBroadcastProvider } from '../lib/yjs-supabase-provider'
import { useYjsTextarea } from '../lib/use-yjs-textarea'
import DocumentSharePanel from './DocumentSharePanel'
import MarkdownPreview from './MarkdownPreview'
import SplitPane from './SplitPane'
/** @typedef {import('../lib/supabase').Document} Document */
/** @typedef {import('../lib/supabase').SharePermission} SharePermission */

// Debounce delay for persisting the Yjs state + plain text to the database.
// Broadcast handles real-time sync between editors; the DB save is a periodic
// durability snapshot — 5 s keeps WAL churn low while REPLICA IDENTITY FULL
// writes all columns (including yjs_state) on every UPDATE.
const SAVE_DELAY = 5000

/**
 * Full-screen split-pane Markdown editor with live GFM preview, real-time
 * collaborative editing via Yjs (CRDT) and Supabase Realtime Broadcast,
 * and debounced auto-save.
 *
 * Left pane: monospace textarea for raw Markdown.
 * Right pane: live-rendered preview (react-markdown + remark-gfm, XSS-safe).
 *
 * The preview receives a deferred copy of the body so the textarea stays
 * responsive on large documents (rerender-use-deferred-value).
 *
 * Yjs handles conflict-free merging of concurrent edits from multiple
 * clients.  Broadcast carries the low-latency, per-keystroke updates;
 * the DB save writes both the encoded CRDT state (`yjs_state`) and the
 * plain-text extraction (`body`) atomically.
 *
 * @param {{
 *   document: Document,
 *   userId: string,
 *   isOwner: boolean,
 *   permission: SharePermission | null,
 * }} props
 */
export default function DocumentEditor({ document: doc, userId, isOwner, permission }) {
  const navigate = useNavigate()
  const [saveStatus, setSaveStatus] = useState(/** @type {'idle' | 'saving' | 'saved' | 'error'} */ ('idle'))
  const [saveError, setSaveError] = useState(/** @type {string | null} */ (null))

  // Exit animation state — briefly true before navigating away.
  const [exiting, setExiting] = useState(false)

  // Share panel visibility (owner only).
  const [sharePanelOpen, setSharePanelOpen] = useState(false)
  // Toast message (passed to share panel callbacks).
  const [toast, setToast] = useState(/** @type {string | null} */ (null))

  // Permission-derived flags (rerender-derived-state-no-effect).
  const canEdit = isOwner || permission === 'edit'

  // ── Yjs document — stable across renders (rerender-lazy-state-init) ─────
  // useState with a factory function creates the Y.Doc exactly once per mount.
  // The component is keyed by doc.id in DocumentEditorRoute, so switching
  // documents cleanly unmounts/remounts.
  const [ydoc] = useState(() => {
    const d = new Y.Doc()
    // Hydrate from persisted CRDT state, or seed from plain-text body for
    // pre-existing documents that don't have yjs_state yet.
    if (doc.yjs_state) {
      Y.applyUpdate(d, fromBase64(doc.yjs_state))
    } else {
      if (doc.title) d.getText('title').insert(0, doc.title)
      if (doc.body) d.getText('body').insert(0, doc.body)
    }
    return d
  })

  // ── Bind Y.Text('title') ↔ title input ─────────────────────────────────
  const { value: title, onChange: onTitleChange, inputRef: titleInputRef } = useYjsTextarea(ydoc, 'title')

  // ── Bind Y.Text('body') ↔ textarea ─────────────────────────────────────
  const { value: body, onChange: onBodyChange, applyEdit, inputRef: textareaRef } = useYjsTextarea(ydoc, 'body')

  // Deferred body — React prioritises the textarea update and renders the
  // preview when idle (rerender-use-deferred-value).
  const deferredBody = useDeferredValue(body)
  const isStale = body !== deferredBody

  // ── Broadcast provider (collaborative sync) ─────────────────────────────
  // Only editors join the Broadcast channel. View-only users render the
  // static body from the DB and skip Yjs entirely.
  const providerRef = useRef(/** @type {SupabaseBroadcastProvider | null} */ (null))

  useEffect(() => {
    if (!canEdit) return

    const provider = new SupabaseBroadcastProvider({
      supabaseClient: supabase,
      ydoc,
      documentId: doc.id,
      canEdit,
    })
    providerRef.current = provider

    return () => {
      provider.destroy()
      providerRef.current = null
    }
  }, [ydoc, doc.id, canEdit])

  // ── Dirty tracking for auto-save ────────────────────────────────────────
  // A simple ref flag: set to true by Y.Text observers (local + remote
  // edits on title or body).  Cleared after a successful DB save.
  const dirtyRef = useRef(false)

  useEffect(() => {
    if (!canEdit) return

    const ytitle = ydoc.getText('title')
    const ybody = ydoc.getText('body')
    const markDirty = () => { dirtyRef.current = true }
    ytitle.observe(markDirty)
    ybody.observe(markDirty)
    return () => {
      ytitle.unobserve(markDirty)
      ybody.unobserve(markDirty)
    }
  }, [ydoc, canEdit])

  // ── Auto-save (debounced) ───────────────────────────────────────────────

  useEffect(() => {
    // View-only users never auto-save.
    if (!canEdit) return

    // Skip save when nothing has changed.
    if (!dirtyRef.current) return

    const timer = setTimeout(async () => {
      // Re-check after the timeout — a concurrent save may have cleared it.
      if (!dirtyRef.current) return

      setSaveStatus('saving')

      const titleText = ydoc.getText('title').toString().trim() || 'Untitled document'
      const plainText = ydoc.getText('body').toString()
      const encoded = toBase64(Y.encodeStateAsUpdate(ydoc))

      const patch = { title: titleText, body: plainText || null, yjs_state: encoded }

      const { error } = await supabase
        .from('documents')
        .update(patch)
        .eq('id', doc.id)

      if (error) {
        setSaveStatus('error')
        setSaveError(error.message)
      } else {
        setSaveStatus('saved')
        setSaveError(null)
        dirtyRef.current = false
      }
    }, SAVE_DELAY)

    return () => clearTimeout(timer)
  }, [title, body, doc.id, canEdit, ydoc])

  // ── Safety-net save on tab hide / page unload ───────────────────────────

  useEffect(() => {
    if (!canEdit) return

    function saveSnapshot() {
      if (!dirtyRef.current) return

      const titleText = ydoc.getText('title').toString().trim() || 'Untitled document'
      const plainText = ydoc.getText('body').toString()
      const encoded = toBase64(Y.encodeStateAsUpdate(ydoc))

      const patch = { title: titleText, body: plainText || null, yjs_state: encoded }

      // Fire-and-forget — we can't await in unload handlers.
      supabase.from('documents').update(patch).eq('id', doc.id).then()

      dirtyRef.current = false
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') saveSnapshot()
    }

    function onBeforeUnload() {
      saveSnapshot()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [canEdit, doc.id, ydoc])

  // ── Keyboard shortcuts (Ctrl/Cmd + B/I) ─────────────────────────────────
  // Routes through Y.Text operations via applyEdit → broadcasts to peers →
  // updates all previews.

  const handleKeyDown = useCallback((/** @type {React.KeyboardEvent<HTMLTextAreaElement>} */ e) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return

    /** @type {string | null} */
    let wrapper = null
    /** @type {string | null} */
    let placeholder = null

    if (e.key === 'b') {
      wrapper = '**'
      placeholder = 'bold'
    } else if (e.key === 'i') {
      wrapper = '_'
      placeholder = 'italic'
    }

    if (!wrapper || !textareaRef.current) return

    e.preventDefault()
    const ta = textareaRef.current
    const start = ta.selectionStart
    const end = ta.selectionEnd

    if (start === end) {
      // No selection — insert wrapper+placeholder+wrapper at cursor.
      const insert = `${wrapper}${placeholder}${wrapper}`
      applyEdit(start, 0, insert)
      // Place cursor inside the wrapper so the user can type over the placeholder.
      requestAnimationFrame(() => {
        ta.selectionStart = start + wrapper.length
        ta.selectionEnd = start + wrapper.length + placeholder.length
      })
    } else {
      // Wrap the selected text.
      const selected = body.slice(start, end)
      applyEdit(start, end - start, wrapper + selected + wrapper)
      // Re-select the wrapped text (excluding the wrappers).
      requestAnimationFrame(() => {
        ta.selectionStart = start + wrapper.length
        ta.selectionEnd = end + wrapper.length
      })
    }
  }, [body, applyEdit, textareaRef])

  // ── Close with exit animation ───────────────────────────────────────────

  const handleClose = useCallback(() => {
    setExiting(true)
    setTimeout(() => navigate('/documents'), 180)
  }, [navigate])

  // ── Save-status label ───────────────────────────────────────────────────

  const statusLabel =
    saveStatus === 'saving' ? 'Saving…' :
    saveStatus === 'saved'  ? 'Saved' :
    saveStatus === 'error'  ? (saveError ?? 'Save failed') :
    null // idle — show nothing

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`doc-editor-fullscreen${exiting ? ' doc-editor-fullscreen--exiting' : ''}`}>
      {/* ── Top toolbar ──────────────────────────────────────────────── */}
      <div className="doc-editor-toolbar">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleClose}
        >
          ← Back
        </button>

        <input
          ref={titleInputRef}
          className="doc-editor-title"
          type="text"
          value={title}
          onChange={onTitleChange}
          placeholder="Document title"
          aria-label="Document title"
          readOnly={!canEdit}
          autoFocus={canEdit}
        />

        <div className="doc-editor-toolbar__right">
          {statusLabel !== null ? (
            <span
              className={`save-status ${saveStatus === 'saving' ? 'save-status--saving' : ''} ${saveStatus === 'error' ? 'save-status--error' : ''}`}
              role="status"
            >
              {statusLabel}
            </span>
          ) : null}

          {canEdit ? (
            <span className="doc-editor-shortcut-hint" aria-hidden="true">
              Ctrl+B bold · Ctrl+I italic
            </span>
          ) : null}

          {isOwner ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setSharePanelOpen(true)}
            >
              Share
            </button>
          ) : null}
        </div>
      </div>

      {/* ── Body area ────────────────────────────────────────────────── */}
      <div className="doc-editor-body-area">
        {canEdit ? (
          /* Split pane (desktop side-by-side / narrow stacked) */
          <SplitPane initialLeftPercent={50}>
            <textarea
              ref={textareaRef}
              className="doc-editor-textarea"
              value={body}
              onChange={onBodyChange}
              onKeyDown={handleKeyDown}
              placeholder="Write your Markdown here…"
              spellCheck
            />
            <div className="doc-editor-preview-pane" style={{ opacity: isStale ? 0.85 : 1 }}>
              <MarkdownPreview source={deferredBody} />
            </div>
          </SplitPane>
        ) : (
          /* View-only: full-width rendered Markdown, no editor pane */
          <div className="doc-editor-preview-pane" style={{ height: '100%' }}>
            <MarkdownPreview source={doc.body ?? ''} />
          </div>
        )}
      </div>

      {/* ── Share panel (owner only) ─────────────────────────────────── */}
      {sharePanelOpen ? (
        <DocumentSharePanel
          documentId={doc.id}
          documentTitle={title}
          userId={userId}
          onClose={() => setSharePanelOpen(false)}
          onToast={(msg) => { setToast(msg); setSharePanelOpen(false) }}
        />
      ) : null}

      {/* ── Toast ────────────────────────────────────────────────────── */}
      {toast !== null ? (
        <div className="toast" role="status" onAnimationEnd={() => setTimeout(() => setToast(null), 1200)}>
          {toast}
        </div>
      ) : null}
    </div>
  )
}
