import { useState } from 'react'

/**
 * Presence bar — shows avatar circles for each connected peer.
 * Shows the user's profile image if available, otherwise a centered initial.
 *
 * Defined as a standalone component, not inline inside DocumentEditor
 * (rerender-no-inline-components).
 *
 * @param {{
 *   peers: Array<{ userId: string, displayName: string, color: { dot: string }, avatarUrl?: string | null }>,
 *   selfColor: string,
 *   selfLabel: string,
 *   selfAvatarUrl?: string | null,
 * }} props
 */
export default function PresenceBar({ peers, selfColor, selfLabel, selfAvatarUrl }) {
  return (
    <div className="presence-bar" aria-label="Connected users">
      {/* Local user — always first, with a ring indicator */}
      <PresenceDot
        color={selfColor}
        label={`${selfLabel} (you)`}
        avatarUrl={selfAvatarUrl}
        displayName={selfLabel}
        isSelf
      />

      {/* Remote peers */}
      {peers.map((p) => (
        <PresenceDot
          key={p.userId}
          color={p.color.dot}
          label={p.displayName}
          avatarUrl={p.avatarUrl}
          displayName={p.displayName}
        />
      ))}
    </div>
  )
}

/**
 * Single presence circle — img with fallback to centered initial.
 * Defined at module top level (rerender-no-inline-components).
 */
function PresenceDot({ color, label, avatarUrl, displayName, isSelf }) {
  const [imgError, setImgError] = useState(false)
  const showImg = avatarUrl && !imgError
  const cls = `presence-dot${isSelf ? ' presence-dot--self' : ''}`

  return (
    <span
      className={cls}
      style={{ borderColor: color, background: showImg ? 'transparent' : color }}
      title={label}
    >
      {showImg ? (
        <img
          className="presence-dot__img"
          src={avatarUrl}
          alt=""
          onError={() => setImgError(true)}
        />
      ) : (
        initial(displayName)
      )}
    </span>
  )
}

/** First letter of a display name, uppercased. */
function initial(name) {
  return name && name.length > 0 ? name[0].toUpperCase() : '?'
}
