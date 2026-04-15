import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * CSS properties copied to the hidden mirror div so its word-wrapping
 * matches the textarea exactly.
 */
const MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'wordSpacing', 'textIndent', 'textTransform', 'wordWrap', 'overflowWrap',
  'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
]

/**
 * Transparent overlay positioned on top of the textarea that shows a
 * colored line highlight on the row where each remote user's cursor is.
 *
 * Uses a hidden mirror div to measure the visual Y position of each
 * cursor offset, correctly accounting for word-wrapped lines.
 * Renders overlay children via direct DOM manipulation in a layout effect
 * to avoid ref-in-render lint violations.
 *
 * @param {{
 *   textareaRef: React.RefObject<HTMLTextAreaElement | null>,
 *   text: string,
 *   remoteCursors: Array<{ userId: string, displayName: string, color: { dot: string, paletteIndex: number }, cursorPos: number }>,
 * }} props
 */
export default function CursorOverlay({ textareaRef, text, remoteCursors }) {
  const overlayRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const mirrorRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const markerRef = useRef(/** @type {HTMLSpanElement | null} */ (null))

  const [lineHeight, setLineHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  // Vertical pixel offset to calibrate mirror-div Y against textarea Y.
  const calibrationRef = useRef(0)

  // ── Create a hidden mirror div + marker span once ─────────────────────
  useEffect(() => {
    const mirror = document.createElement('div')
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.top = '-9999px'
    mirror.style.left = '-9999px'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.wordWrap = 'break-word'
    mirror.style.overflowWrap = 'break-word'
    mirror.style.overflow = 'hidden'
    document.body.appendChild(mirror)
    mirrorRef.current = mirror

    const marker = document.createElement('span')
    marker.textContent = '\u200b' // zero-width space
    markerRef.current = marker

    return () => {
      document.body.removeChild(mirror)
      mirrorRef.current = null
      markerRef.current = null
    }
  }, [])

  // ── Measure line-height from the textarea ──────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return

    function measure() {
      const cs = getComputedStyle(ta)
      const fontSize = parseFloat(cs.fontSize) || 14
      const lh = cs.lineHeight
      setLineHeight(lh === 'normal' ? fontSize * 1.2 : parseFloat(lh))
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(ta)
    return () => ro.disconnect()
  }, [textareaRef])

  // ── Sync scroll position ──────────────────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return

    function onScroll() {
      setScrollTop(ta.scrollTop)
    }
    ta.addEventListener('scroll', onScroll, { passive: true })
    setScrollTop(ta.scrollTop)
    return () => ta.removeEventListener('scroll', onScroll)
  }, [textareaRef])

  // ── Build overlay children imperatively in a layout effect ────────────
  // Reuses existing DOM elements keyed by userId so the CSS transition on
  // `top` animates when the highlight moves between rows.
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    const marker = markerRef.current
    if (!overlay) return

    if (!ta || !mirror || !marker || remoteCursors.length === 0) {
      overlay.textContent = ''
      return
    }

    // Sync mirror styles once per measurement pass.
    const cs = getComputedStyle(ta)
    for (const prop of MIRROR_PROPS) {
      mirror.style[prop] = cs[prop]
    }
    mirror.style.boxSizing = cs.boxSizing
    mirror.style.width = ta.offsetWidth + 'px'

    // Calibrate: measure where the mirror puts the first character vs
    // where it actually appears in the textarea (browsers add internal
    // padding to textareas that divs don't replicate).
    mirror.textContent = ''
    mirror.appendChild(marker)
    const mirrorFirstY = marker.offsetTop
    const taFirstY = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
    calibrationRef.current = taFirstY - mirrorFirstY

    // Build a set of active userIds so we can prune stale elements.
    const activeIds = new Set(remoteCursors.map((c) => c.userId))

    // Remove elements for users no longer present.
    for (const el of [...overlay.children]) {
      if (!activeIds.has(/** @type {HTMLElement} */ (el).dataset.userId)) {
        overlay.removeChild(el)
      }
    }

    // Index existing children by userId for reuse.
    /** @type {Map<string, HTMLElement>} */
    const existing = new Map()
    for (const el of overlay.children) {
      existing.set(/** @type {HTMLElement} */ (el).dataset.userId, /** @type {HTMLElement} */ (el))
    }

    for (const c of remoteCursors) {
      const before = text.substring(0, c.cursorPos)
      mirror.textContent = before
      mirror.appendChild(marker)
      const top = marker.offsetTop + calibrationRef.current - scrollTop

      let line = existing.get(c.userId)
      if (!line) {
        line = document.createElement('div')
        line.className = 'cursor-overlay__line'
        line.dataset.userId = c.userId
        const label = document.createElement('span')
        label.className = 'cursor-overlay__label'
        line.appendChild(label)
        overlay.appendChild(line)
      }

      line.dataset.palette = String(c.color.paletteIndex)
      line.style.top = `${top}px`
      line.style.height = `${lineHeight}px`

      const label = /** @type {HTMLSpanElement} */ (line.firstChild)
      label.style.background = c.color.dot
      label.textContent = c.displayName
    }
  }, [textareaRef, text, remoteCursors, scrollTop, lineHeight])

  return <div ref={overlayRef} className="cursor-overlay" aria-hidden="true" />
}
