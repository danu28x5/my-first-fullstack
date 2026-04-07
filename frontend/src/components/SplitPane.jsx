import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Resizable split-pane layout — two children separated by a draggable divider.
 *
 * Drag logic uses refs + direct DOM mutations so zero re-renders happen
 * mid-drag (rerender-use-ref-transient-values). Final width is committed
 * to state on mouseup (one re-render per completed drag).
 *
 * @param {{ initialLeftPercent?: number, children: [React.ReactNode, React.ReactNode] }} props
 */
export default function SplitPane({ initialLeftPercent = 50, children }) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const dragging = useRef(false)
  const [leftPercent, setLeftPercent] = useState(initialLeftPercent)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    // Prevent text selection while dragging.
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    function onMouseMove(e) {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      const clamped = Math.min(Math.max(pct, 15), 85)

      // Direct DOM mutation during drag — no React re-render
      // (rerender-use-ref-transient-values). Writes are batched —
      // no layout read interleaved (js-batch-dom-css).
      const panes = containerRef.current.querySelectorAll('.split-pane__panel')
      if (panes[0]) panes[0].style.width = `${clamped}%`
      if (panes[1]) panes[1].style.width = `${100 - clamped}%`
    }

    function onMouseUp() {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''

      // Commit final width to state — single re-render per drag.
      if (containerRef.current) {
        const pane = containerRef.current.querySelector('.split-pane__panel')
        if (pane) setLeftPercent(parseFloat(pane.style.width))
      }
    }

    // Passive — we never call preventDefault on mousemove (client-passive-event-listeners).
    document.addEventListener('mousemove', onMouseMove, { passive: true })
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-pane__panel" style={{ width: `${leftPercent}%` }}>
        {children[0]}
      </div>
      <div
        className="split-pane__divider"
        onMouseDown={onMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        tabIndex={0}
      />
      <div className="split-pane__panel" style={{ width: `${100 - leftPercent}%` }}>
        {children[1]}
      </div>
    </div>
  )
}
