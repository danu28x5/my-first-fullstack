import * as Y from 'yjs'
import { toBase64, fromBase64 } from './base64'

// ── Deterministic user color ──────────────────────────────────────────────
// Curated palette of 8 colors that look good against both light and dark
// backgrounds.  `dot` is the solid accent used for avatar borders and cursor
// labels.  Highlight colours are set per-theme in CSS via data-palette
// attributes, so only `dot` and `paletteIndex` are needed here.

const PALETTE = [
  '#e06c75', // rose
  '#d19a66', // amber
  '#e5c07b', // gold
  '#98c379', // green
  '#56b6c2', // teal
  '#61afef', // blue
  '#c678dd', // purple
  '#be5046', // rust
]

/**
 * @param {string} userId
 * @returns {{ dot: string, paletteIndex: number }}
 */
export function userColor(userId) {
  let hash = 5381
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash + userId.charCodeAt(i)) | 0
  }
  const idx = ((hash % PALETTE.length) + PALETTE.length) % PALETTE.length
  return { dot: PALETTE[idx], paletteIndex: idx }
}

/**
 * Custom Yjs provider that syncs a Y.Doc via Supabase Realtime Broadcast.
 *
 * Broadcast is an ephemeral, low-latency client→relay→clients pub/sub channel.
 * It does not involve Postgres or the WAL — ideal for high-frequency Yjs
 * updates (every keystroke).
 *
 * ## Sync protocol
 *
 * When a new client subscribes it broadcasts a `sync-request` containing its
 * local state vector (base64-encoded).  Any existing client that receives the
 * request responds with a `sync-response` containing the diff the new client
 * is missing.  If no response arrives within 2 seconds the new client assumes
 * it is the only one (DB state was already loaded by the caller).
 *
 * Ongoing edits are broadcast as `yjs-update` messages.  Remote updates are
 * applied with origin `'remote'` so the ydoc update handler can skip echoing
 * them back.
 *
 * ## Awareness protocol
 *
 * Ephemeral presence state (user name, color, cursor position) is broadcast
 * over the same channel using `awareness-update` and `awareness-leave` events.
 * A 15-second stale-peer timeout removes clients that disconnect without
 * sending a leave message.
 */
export class SupabaseBroadcastProvider {
  /**
   * @param {{
   *   supabaseClient: import('@supabase/supabase-js').SupabaseClient,
   *   ydoc: Y.Doc,
   *   documentId: number | string,
   *   canEdit: boolean,
   *   userId: string,
   *   displayName: string,
   *   avatarUrl?: string | null,
   * }} opts
   */
  constructor({ supabaseClient, ydoc, documentId, canEdit, userId, displayName, avatarUrl }) {
    this.ydoc = ydoc
    this.supabaseClient = supabaseClient
    this.canEdit = canEdit
    this.synced = false
    this._destroyed = false
    this._channelName = `doc:collab:${documentId}`

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._syncTimeout = null
    this._retryCount = 0

    // ── Awareness state ───────────────────────────────────────────────
    this.userId = userId
    this.displayName = displayName
    this.avatarUrl = avatarUrl ?? null
    this.color = userColor(userId)

    /** @type {Map<string, { userId: string, displayName: string, color: { dot: string, paletteIndex: number }, cursorPos: number, avatarUrl: string | null, lastSeen: number }>} */
    this.peers = new Map()

    /** Callback set by the component to react to awareness changes. */
    /** @type {(() => void) | null} */
    this._onAwarenessChange = null

    /** Timestamp of the last outgoing cursor broadcast (throttle to 200ms). */
    this._lastCursorBroadcast = 0

    // ── Create the Broadcast channel ──────────────────────────────────
    this.channel = supabaseClient.channel(this._channelName)

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._retryTimer = null

    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatInterval = null

    // Register broadcast listeners and subscribe with sync handshake.
    this._registerListeners()
    this._subscribe()

    // ── Outgoing: broadcast local updates to other clients ────────────
    // Only editors send; view-only clients receive but never broadcast.
    /** @type {((update: Uint8Array, origin: any) => void) | null} */
    this._updateHandler = null

    if (canEdit) {
      this._updateHandler = (update, origin) => {
        // Skip updates that came from a remote peer (origin === 'remote')
        // to avoid echoing received changes back to the channel.
        if (origin === 'remote' || this._destroyed) return
        this.channel.send({
          type: 'broadcast',
          event: 'yjs-update',
          payload: { data: toBase64(update) },
        })
      }
      this.ydoc.on('update', this._updateHandler)
    }

    // ── Stale-peer cleanup (every 5 s, evict peers older than 15 s) ───
    this._awarenessCleanupInterval = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [key, peer] of this.peers) {
        if (now - peer.lastSeen > 120_000) {
          this.peers.delete(key)
          changed = true
        }
      }
      if (changed) this._onAwarenessChange?.()
    }, 5000)

    // ── Send awareness-leave on page unload ───────────────────────────
    this._beforeUnloadHandler = () => {
      if (this._destroyed) return
      this.channel.send({
        type: 'broadcast',
        event: 'awareness-leave',
        payload: { userId: this.userId },
      })
    }
    window.addEventListener('beforeunload', this._beforeUnloadHandler)
  }

  /** @private Subscribe to the channel with retry on transient errors. */
  _subscribe() {
    this.channel.subscribe((status) => {
      if (this._destroyed) return

      if (status === 'SUBSCRIBED') {
        this._retryCount = 0
        // Ask existing clients for their state.
        const sv = Y.encodeStateVector(this.ydoc)
        this.channel.send({
          type: 'broadcast',
          event: 'sync-request',
          payload: { stateVector: toBase64(sv) },
        })

        // Announce our presence to existing clients.
        this.channel.send({
          type: 'broadcast',
          event: 'awareness-update',
          payload: {
            userId: this.userId,
            displayName: this.displayName,
            color: this.color,
            cursorPos: 0,
            avatarUrl: this.avatarUrl,
          },
        })

        // If nobody responds within 4 s we're the only client — the
        // caller already loaded DB state so we're good.  (4 s accommodates
        // higher production latency vs localhost.)
        this._syncTimeout = setTimeout(() => {
          this.synced = true
          this._syncTimeout = null
        }, 4000)

        // ── Periodic re-sync heartbeat ────────────────────────────────
        // Every 10 s, broadcast our state vector.  Peers that are ahead
        // reply with the diff — this catches any silently dropped
        // yjs-update messages mid-session.
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval)
        this._heartbeatInterval = setInterval(() => {
          if (this._destroyed) return
          const sv = Y.encodeStateVector(this.ydoc)
          this.channel.send({
            type: 'broadcast',
            event: 'sync-heartbeat',
            payload: { stateVector: toBase64(sv) },
          })
        }, 10_000)
      } else if (
        (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') &&
        this._retryCount < 10
      ) {
        this._retryCount++
        const delay = Math.min(1000 * 2 ** this._retryCount, 30_000)
        this._retryTimer = setTimeout(() => {
          if (this._destroyed) return
          // Remove old channel by reference (see destroy() for rationale).
          const channels = this.supabaseClient.realtime.channels
          const idx = channels.indexOf(this.channel)
          if (idx !== -1) channels.splice(idx, 1)
          this.channel = this.supabaseClient.channel(this._channelName)
          // Re-register broadcast listeners on the new channel.
          this._registerListeners()
          this._subscribe()
        }, delay)
      }
    })
  }

  /** @private Register broadcast event listeners on the current channel. */
  _registerListeners() {
    this.channel.on('broadcast', { event: 'yjs-update' }, (msg) => {
      if (this._destroyed) return
      try {
        const update = fromBase64(msg.payload.data)
        Y.applyUpdate(this.ydoc, update, 'remote')
      } catch { /* ignore malformed messages */ }
    })

    this.channel.on('broadcast', { event: 'sync-request' }, (msg) => {
      if (this._destroyed) return
      try {
        const remoteVector = fromBase64(msg.payload.stateVector)
        const diff = Y.encodeStateAsUpdate(this.ydoc, remoteVector)
        this.channel.send({
          type: 'broadcast',
          event: 'sync-response',
          payload: { data: toBase64(diff) },
        })
      } catch { /* ignore malformed messages */ }
    })

    this.channel.on('broadcast', { event: 'sync-response' }, (msg) => {
      if (this._destroyed) return
      try {
        const diff = fromBase64(msg.payload.data)
        Y.applyUpdate(this.ydoc, diff, 'remote')
        this.synced = true
        if (this._syncTimeout) {
          clearTimeout(this._syncTimeout)
          this._syncTimeout = null
        }
      } catch { /* ignore malformed messages */ }
    })

    // ── Heartbeat listener (periodic re-sync) ─────────────────────────
    // When a peer broadcasts its state vector, diff against our local doc.
    // If they're behind, send them the missing updates.
    this.channel.on('broadcast', { event: 'sync-heartbeat' }, (msg) => {
      if (this._destroyed) return
      try {
        const remoteVector = fromBase64(msg.payload.stateVector)
        const diff = Y.encodeStateAsUpdate(this.ydoc, remoteVector)
        // Only send if there's actually data to send (non-empty diff).
        if (diff.byteLength > 2) {
          this.channel.send({
            type: 'broadcast',
            event: 'sync-response',
            payload: { data: toBase64(diff) },
          })
        }
      } catch { /* ignore malformed messages */ }
    })

    // ── Awareness listeners ───────────────────────────────────────────
    this.channel.on('broadcast', { event: 'awareness-update' }, (msg) => {
      if (this._destroyed) return
      try {
        const { userId, displayName, color, cursorPos, avatarUrl } = msg.payload
        if (userId === this.userId) return // skip self
        const resolvedColor = this._resolveColor(color, userId)
        this.peers.set(userId, { userId, displayName, color: resolvedColor, cursorPos, avatarUrl: avatarUrl ?? null, lastSeen: Date.now() })
        this._onAwarenessChange?.()
      } catch { /* ignore malformed messages */ }
    })

    this.channel.on('broadcast', { event: 'awareness-leave' }, (msg) => {
      if (this._destroyed) return
      try {
        const { userId } = msg.payload
        if (userId === this.userId) return
        if (this.peers.delete(userId)) {
          this._onAwarenessChange?.()
        }
      } catch { /* ignore malformed messages */ }
    })
  }

  /**
   * Broadcast the local user's cursor position to peers.
   * Throttled to at most once per 200 ms to avoid flooding the channel.
   * @param {number} cursorPos — character offset in the body text
   */
  broadcastCursor(cursorPos) {
    if (this._destroyed) return
    const now = Date.now()
    if (now - this._lastCursorBroadcast < 200) return
    this._lastCursorBroadcast = now
    this.channel.send({
      type: 'broadcast',
      event: 'awareness-update',
      payload: {
        userId: this.userId,
        displayName: this.displayName,
        color: this.color,
        cursorPos,
        avatarUrl: this.avatarUrl,
      },
    })
  }

  /**
   * Resolve color collisions within the current session.
   * If the incoming peer's paletteIndex collides with our own or any
   * existing peer, shift to the nearest free slot (0–7).
   * @param {{ dot: string, paletteIndex: number }} color
   * @param {string} peerId
   * @returns {{ dot: string, paletteIndex: number }}
   */
  _resolveColor(color, peerId) {
    const taken = new Set([this.color.paletteIndex])
    for (const [id, peer] of this.peers) {
      if (id !== peerId) taken.add(peer.color.paletteIndex)
    }
    if (!taken.has(color.paletteIndex)) return color
    // Find the nearest free slot.
    for (let offset = 1; offset < PALETTE.length; offset++) {
      const candidate = (color.paletteIndex + offset) % PALETTE.length
      if (!taken.has(candidate)) {
        return { dot: PALETTE[candidate], paletteIndex: candidate }
      }
    }
    // All 8 slots taken — fall back to original (rare: 9+ users).
    return color
  }

  /** Clean up: unregister ydoc listener and remove the Broadcast channel. */
  destroy() {
    this._destroyed = true

    // ── Awareness cleanup ─────────────────────────────────────────────
    clearInterval(this._awarenessCleanupInterval)
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval)
      this._heartbeatInterval = null
    }
    window.removeEventListener('beforeunload', this._beforeUnloadHandler)
    this.peers.clear()

    // Notify peers we're leaving (best-effort — channel may already be gone).
    try {
      this.channel.send({
        type: 'broadcast',
        event: 'awareness-leave',
        payload: { userId: this.userId },
      })
    } catch { /* ignore if channel is already closed */ }

    if (this._syncTimeout) {
      clearTimeout(this._syncTimeout)
      this._syncTimeout = null
    }
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this._updateHandler) {
      this.ydoc.off('update', this._updateHandler)
      this._updateHandler = null
    }

    // Synchronously remove this specific channel instance from the Supabase
    // client's internal array (by reference).  We avoid removeChannel() and
    // direct unsubscribe() because both trigger an _onClose callback inside
    // the Realtime client that filters ALL channels with the same *topic* —
    // which would remove a new channel created by React 19 StrictMode's
    // immediate remount.
    const ch = this.channel
    const client = this.supabaseClient
    const channels = client.realtime.channels
    const idx = channels.indexOf(ch)
    if (idx !== -1) channels.splice(idx, 1)

    // Defer the actual server-side leave to the next tick so StrictMode's
    // remount can create and register the replacement channel first.
    // If a new channel with the same topic already exists, skip the
    // unsubscribe — the server treats the new join as a rejoin.
    setTimeout(() => {
      const hasSameTopic = client.realtime.channels.some(
        (c) => c.topic === ch.topic
      )
      if (!hasSameTopic) {
        ch.unsubscribe()
      }
    }, 0)
  }
}
