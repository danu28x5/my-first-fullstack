import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Compute the minimal edit (single contiguous region) to transform
 * `oldStr` into `newStr`.  Assumes a single contiguous edit — which
 * is what a textarea `onChange` always produces.
 *
 * Finds a common prefix, then a common suffix (not overlapping the
 * prefix), and returns the position, delete count, and inserted text.
 *
 * @param {string} oldStr
 * @param {string} newStr
 * @returns {{ index: number, deleteCount: number, insert: string }}
 */
function diffStrings(oldStr, newStr) {
  // Common prefix
  let start = 0
  while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
    start++
  }

  // Common suffix (don't overlap with prefix)
  let oldEnd = oldStr.length
  let newEnd = newStr.length
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  return {
    index: start,
    deleteCount: oldEnd - start,
    insert: newStr.slice(start, newEnd),
  }
}

/**
 * Transaction origin tag for changes applied via the textarea onChange
 * handler.  The Y.Text observer skips these because onChange already
 * calls setValue — re-running the observer would be redundant and would
 * disrupt the cursor position.
 */
const TEXTAREA_ORIGIN = 'textarea-input'

/**
 * React hook that binds a `Y.Text` shared type to a controlled text input
 * (`<textarea>` or `<input type="text">`).
 *
 * Returns `{ value, onChange, applyEdit, inputRef }` — drop-in
 * replacements for the element's `value`, `onChange`, and `ref` props.
 *
 * `applyEdit` is for programmatic edits (e.g. keyboard shortcuts) that
 * need to mutate the shared text directly rather than going through
 * the element's `onChange` event.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {string} fieldName — name of the shared text (e.g. 'body')
 * @returns {{
 *   value: string,
 *   onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => void,
 *   applyEdit: (index: number, deleteCount: number, insert: string) => void,
 *   inputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
 * }}
 */
export function useYjsTextarea(ydoc, fieldName) {
  const ytextRef = useRef(ydoc.getText(fieldName))
  const inputRef = useRef(/** @type {HTMLTextAreaElement | HTMLInputElement | null} */ (null))

  // Initialise from the Y.Text shared type directly (not via ref) to
  // satisfy the react-hooks/refs lint rule.
  const [value, setValue] = useState(() => ydoc.getText(fieldName).toString())

  // ── Remote / programmatic → React state ─────────────────────────────
  // The observer's second argument is the Yjs transaction.  We use its
  // `origin` to decide whether to update React state:
  //
  //   origin === TEXTAREA_ORIGIN  → skip (onChange already called setValue)
  //   origin === 'remote'         → update state + restore cursor
  //   origin === anything else    → update state (e.g. applyEdit from
  //                                  keyboard shortcuts; caller sets cursor)
  useEffect(() => {
    const ytext = ytextRef.current

    /** @param {any} _event @param {import('yjs').Transaction} transaction */
    const observer = (_event, transaction) => {
      // onChange already updated React state — skip to avoid a redundant
      // re-render and cursor disruption.
      if (transaction.origin === TEXTAREA_ORIGIN) return

      const el = inputRef.current
      const prevStart = el ? el.selectionStart ?? 0 : 0
      const prevEnd = el ? el.selectionEnd ?? 0 : 0
      // Read current length from the DOM element, not from a stale closure.
      const prevLen = el ? el.value.length : 0

      const next = ytext.toString()
      setValue(next)

      // Restore cursor only for remote edits — programmatic edits (applyEdit)
      // set the cursor themselves via requestAnimationFrame in the caller.
      if (el && transaction.origin === 'remote') {
        queueMicrotask(() => {
          const delta = next.length - prevLen
          el.selectionStart = Math.max(0, prevStart + delta)
          el.selectionEnd = Math.max(0, prevEnd + delta)
        })
      }
    }

    ytext.observe(observer)
    return () => ytext.unobserve(observer)
  }, [ydoc, fieldName])

  // ── Local input → Y.Text ───────────────────────────────────────────
  const onChange = useCallback((/** @type {React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>} */ e) => {
    const newValue = e.target.value
    const oldValue = ytextRef.current.toString()
    const { index, deleteCount, insert } = diffStrings(oldValue, newValue)

    // Tag with TEXTAREA_ORIGIN so the observer skips this change.
    ydoc.transact(() => {
      if (deleteCount > 0) ytextRef.current.delete(index, deleteCount)
      if (insert) ytextRef.current.insert(index, insert)
    }, TEXTAREA_ORIGIN)

    // Update React state immediately so the textarea stays responsive.
    setValue(newValue)
  }, [ydoc])

  // ── Programmatic edits (keyboard shortcuts, etc.) ───────────────────
  // No origin tag — the observer fires and calls setValue so React
  // re-renders.  The caller sets the cursor via requestAnimationFrame.
  const applyEdit = useCallback((/** @type {number} */ index, /** @type {number} */ deleteCount, /** @type {string} */ insert) => {
    ydoc.transact(() => {
      if (deleteCount > 0) ytextRef.current.delete(index, deleteCount)
      if (insert) ytextRef.current.insert(index, insert)
    })
  }, [ydoc])

  return { value, onChange, applyEdit, inputRef }
}
