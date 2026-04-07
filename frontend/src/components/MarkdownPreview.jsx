import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Module-level plugin array — never recreated on re-render (rendering-hoist-jsx).
const plugins = [remarkGfm]

// Memoized so it only re-renders when the source string actually changes.
// Paired with useDeferredValue in the parent so the textarea stays responsive
// while the preview catches up (rerender-memo, rerender-use-deferred-value).
// XSS-safe by architecture — react-markdown renders React elements, never
// uses dangerouslySetInnerHTML. Raw HTML in the source is dropped by default.
const MarkdownPreview = memo(function MarkdownPreview({ source }) {
  return (
    <div className="markdown-preview">
      {source ? (
        <Markdown remarkPlugins={plugins}>{source}</Markdown>
      ) : (
        <p className="markdown-preview__empty">Start typing to see a preview…</p>
      )}
    </div>
  )
})

export default MarkdownPreview
