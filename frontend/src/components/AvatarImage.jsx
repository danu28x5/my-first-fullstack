import { useState } from 'react'

// AvatarImage is defined at module top level (rerender-no-inline-components).

/**
 * Get up to two initials from a display name, or fall back to the first
 * character of an email address.
 *
 * @param {string | null | undefined} displayName
 * @param {string | null | undefined} email
 * @returns {string}
 */
function getInitials(displayName, email) {
  if (displayName && displayName.trim().length > 0) {
    const parts = displayName.trim().split(/\s+/)
    if (parts.length === 1) return parts[0][0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }
  if (email && email.length > 0) return email[0].toUpperCase()
  return '?'
}

/**
 * Circular avatar — shows the image when a signed URL is provided and it
 * loads successfully; otherwise shows an initials placeholder.
 *
 * Use `key={signedUrl}` at the call site to reset the error state when the
 * URL changes (e.g. after a new upload).
 *
 * @param {{
 *   signedUrl: string | null | undefined,
 *   displayName: string | null | undefined,
 *   email: string | null | undefined,
 *   size?: 'sm' | 'lg',
 *   className?: string,
 * }} props
 */
export default function AvatarImage({
  signedUrl,
  displayName,
  email,
  size = 'sm',
  className = '',
}) {
  // Track whether the <img> failed to load so we can fall back to the
  // initials placeholder without an ugly broken-image icon.
  const [imgError, setImgError] = useState(false)

  const cls = `avatar avatar--${size}${className ? ' ' + className : ''}`
  const label = displayName ?? email ?? 'User avatar'

  if (signedUrl && !imgError) {
    return (
      <img
        src={signedUrl}
        alt={label}
        className={cls}
        onError={() => setImgError(true)}
      />
    )
  }

  // Initials placeholder — aria-label provides the accessible name that
  // <img alt> would normally supply.
  return (
    <div
      className={`${cls} avatar--placeholder`}
      aria-label={label}
      role="img"
    >
      {getInitials(displayName, email)}
    </div>
  )
}
