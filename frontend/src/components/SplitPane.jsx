import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Resizable split-pane layout — two children separated by a draggable divider.
 *
 * Automatically detects whether the container is in row (horizontal) or column
 * (vertical) layout via getComputedStyle so the same component works for both
 * desktop side-by-side and mobile stacked arrangements.
 *
 * Drag logic uses refs + direct DOM mutations so zero re-renders happen
 * mid-drag (rerender-use-ref-transient-values). Final size is committed
 * to state on pointer-up (one re-render per completed drag).
 *
 * @param {{ initialLeftPercent?: number, children: [React.ReactNode, React.ReactNode] }} props
 */
export default function SplitPane({ initialLeftPercent = 50, children }) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null))
  const dragging = useRef(false)
  const [firstPercent, setFirstPercent] = useState(initialLeftPercent)

  /** @returns {boolean} true when the pane is stacked vertically */
  const isColumn = useCallback(() => {
    if (!containerRef.current) return false
    return getComputedStyle(containerRef.current).flexDirection === 'column'
  }, [])

  const onPointerDown = useCallback((e) => {
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    dragging.current = true
    document.body.style.cursor = isColumn() ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
  }, [isColumn])

  useEffect(() => {
    function onPointerMove(e) {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const col = isColumn()
      const pct = col
        ? ((e.clientY - rect.top) / rect.height) * 100
        : ((e.clientX - rect.left) / rect.width) * 100
      const clamped = Math.min(Math.max(pct, 15), 85)

      const panes = containerRef.current.querySelectorAll('.split-pane__panel')
      if (col) {
        if (panes[0]) { panes[0].style.height = `${clamped}%`; panes[0].style.flex = 'none' }
        if (panes[1]) { panes[1].style.height = `${100 - clamped}%`; panes[1].style.flex = 'none' }
      } else {
        if (panes[0]) panes[0].style.width = `${clamped}%`
        if (panes[1]) panes[1].style.width = `${100 - clamped}%`
      }
    }

    function onPointerUp() {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''

      if (containerRef.current) {
        const pane = containerRef.current.querySelector('.split-pane__panel')
        if (pane) {
          const val = isColumn() ? pane.style.height : pane.style.width
          if (val) setFirstPercent(parseFloat(val))
        }
      }
    }

    document.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerup', onPointerUp)
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
    }
  }, [isColumn])

  // ── Reset stale inline styles when the layout orientation flips ───────
  // After a mobile vertical drag the panels have inline height + flex: none.
  // When the viewport widens back to desktop (row layout) those must be
  // cleared so the CSS width-based layout takes over again, and vice-versa.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let prevCol = isColumn()

    function resetOnBreakpointChange() {
      const col = isColumn()
      if (col === prevCol) return
      prevCol = col

      // Reset layout instantly, then play a single fade-in animation.
      const panes = container.querySelectorAll('.split-pane__panel')
      for (const p of panes) {
        p.style.height = ''
        p.style.flex = ''
        p.style.width = ''
      }

      // When returning to desktop (row), apply 50% widths on the DOM
      // immediately so there is no layoutless frame before React re-renders.
      if (!col && panes.length >= 2) {
        panes[0].style.width = '50%'
        panes[1].style.width = '50%'
      }
      setFirstPercent(50)

      // Restart the animation by removing → reflow → re-adding the class.
      container.classList.remove('split-pane--fade-in')
      void container.offsetHeight
      container.classList.add('split-pane--fade-in')
      container.addEventListener('animationend', () => {
        container.classList.remove('split-pane--fade-in')
      }, { once: true })
    }

    const mql = window.matchMedia('(max-width: 767px)')
    mql.addEventListener('change', resetOnBreakpointChange)
    const ro = new ResizeObserver(resetOnBreakpointChange)
    ro.observe(container)
    return () => {
      mql.removeEventListener('change', resetOnBreakpointChange)
      ro.disconnect()
    }
  }, [isColumn])

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-pane__panel" style={{ width: `${firstPercent}%` }}>
        {children[0]}
      </div>
      <div
        className="split-pane__divider"
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes"
        tabIndex={0}
      />
      <div className="split-pane__panel" style={{ width: `${100 - firstPercent}%` }}>
        {children[1]}
      </div>
    </div>
  )
}
