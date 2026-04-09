import { useCallback, useEffect, useRef, useState, useDeferredValue } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'
import DocumentSharePanel from './DocumentSharePanel'
import MarkdownPreview from './MarkdownPreview'
import SplitPane from './SplitPane'
/** @typedef {import('../lib/supabase').Document} Document */
/** @typedef {import('../lib/supabase').SharePermission} SharePermission */

// Auto-save debounce delay in ms.
const SAVE_DELAY = 1000

/**
 * Full-screen split-pane Markdown editor with live GFM preview and auto-save.
 *
 * Left pane: monospace textarea for raw Markdown.
 * Right pane: live-rendered preview (react-markdown + remark-gfm, XSS-safe).
 *
 * The preview receives a deferred copy of the body so the textarea stays
 * responsive on large documents (rerender-use-deferred-value).
 *
 * Auto-save writes to Supabase after the user stops typing for 1 s.
 * The parent's Realtime subscription picks up the UPDATE event so the
 * document list stays in sync without a callback.
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
  // Lazy state init — functions run once on mount (rerender-lazy-state-init).
  const [title, setTitle] = useState(() => doc.title)
  const [body, setBody] = useState(() => doc.body ?? '')
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
  const canEditTitle = isOwner

  // Deferred body — React prioritises the textarea update and renders the
  // preview when idle (rerender-use-deferred-value).
  const deferredBody = useDeferredValue(body)
  const isStale = body !== deferredBody

  // Ref to track the initial values so we skip the first auto-save on mount.
  const initialRef = useRef({ title: doc.title, body: doc.body ?? '' })
  // Ref to the textarea for keyboard shortcuts.
  const textareaRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null))

  // ── Auto-save (debounced) ───────────────────────────────────────────────

  useEffect(() => {
    // View-only users never auto-save.
    if (!canEdit) return

    // Skip save when nothing has changed from the initial load.
    if (title === initialRef.current.title && body === initialRef.current.body) return

    const timer = setTimeout(async () => {
      setSaveStatus('saving')

      // Shared editors save body only — title changes are owner-only.
      const patch = isOwner
        ? { title: title.trim() || 'Untitled document', body: body || null }
        : { body: body || null }

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
        // Update the baseline so subsequent no-ops are detected.
        initialRef.current = { title, body }
      }
    }, SAVE_DELAY)

    return () => clearTimeout(timer)
  }, [title, body, doc.id, canEdit, isOwner])

  // ── Keyboard shortcuts (Ctrl/Cmd + B/I) ─────────────────────────────────

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
      // No selection — insert placeholder.
      const insert = `${wrapper}${placeholder}${wrapper}`
      const next = body.slice(0, start) + insert + body.slice(end)
      setBody(next)
      // Place cursor inside the wrapper so the user can type over the placeholder.
      requestAnimationFrame(() => {
        ta.selectionStart = start + wrapper.length
        ta.selectionEnd = start + wrapper.length + placeholder.length
      })
    } else {
      // Wrap the selected text.
      const selected = body.slice(start, end)
      const next = body.slice(0, start) + wrapper + selected + wrapper + body.slice(end)
      setBody(next)
      // Re-select the wrapped text (excluding the wrappers).
      requestAnimationFrame(() => {
        ta.selectionStart = start + wrapper.length
        ta.selectionEnd = end + wrapper.length
      })
    }
  }, [body])

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
          className="doc-editor-title"
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Document title"
          aria-label="Document title"
          readOnly={!canEditTitle}
          autoFocus={canEditTitle}
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
              onChange={e => setBody(e.target.value)}
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
