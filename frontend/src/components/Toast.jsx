import { useEffect, useState } from 'react'

// Toast is defined at module top level (rerender-no-inline-components).

export default function Toast({ message, onDismiss }) {
  const [dismissing, setDismissing] = useState(false)

  // After 2s, begin the exit animation (rerender-split-combined-hooks).
  useEffect(() => {
    if (message === null) return
    setDismissing(false)
    const id = setTimeout(() => setDismissing(true), 2000)
    return () => clearTimeout(id)
  }, [message])

  // Once the exit animation flag is set, remove the toast after 300ms.
  useEffect(() => {
    if (!dismissing) return
    const id = setTimeout(onDismiss, 300)
    return () => clearTimeout(id)
  }, [dismissing, onDismiss])

  // message is string | null -- ternary, not && (rendering-conditional-render).
  return message !== null ? (
    <div
      className={`toast${dismissing ? ' toast--dismissing' : ''}`}
      role="status"
      aria-live="polite"
    >
      {message}
    </div>
  ) : null
}
