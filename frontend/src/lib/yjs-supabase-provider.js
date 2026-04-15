import * as Y from 'yjs'
import { toBase64, fromBase64 } from './base64'

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
 */
export class SupabaseBroadcastProvider {
  /**
   * @param {{
   *   supabaseClient: import('@supabase/supabase-js').SupabaseClient,
   *   ydoc: Y.Doc,
   *   documentId: number | string,
   *   canEdit: boolean,
   * }} opts
   */
  constructor({ supabaseClient, ydoc, documentId, canEdit }) {
    this.ydoc = ydoc
    this.supabaseClient = supabaseClient
    this.canEdit = canEdit
    this.synced = false
    this._destroyed = false
    this._channelName = `doc:collab:${documentId}`

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._syncTimeout = null
    this._retryCount = 0

    // ── Create the Broadcast channel ──────────────────────────────────
    this.channel = supabaseClient.channel(this._channelName)

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._retryTimer = null

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

        // If nobody responds within 2 s we're the only client — the
        // caller already loaded DB state so we're good.
        this._syncTimeout = setTimeout(() => {
          this.synced = true
          this._syncTimeout = null
        }, 2000)
      } else if (
        (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') &&
        this._retryCount < 3
      ) {
        this._retryCount++
        const delay = 1000 * this._retryCount
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
  }

  /** Clean up: unregister ydoc listener and remove the Broadcast channel. */
  destroy() {
    this._destroyed = true
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
