/**
 * Base64 ↔ Uint8Array encoding helpers.
 *
 * Supabase Realtime Broadcast channels are JSON-based, and PostgREST
 * serialises bytea columns as Base64 strings.  These helpers bridge
 * the gap between Yjs binary updates (Uint8Array) and the JSON world.
 *
 * Uses btoa/atob + binary-string loops for universal browser compat.
 */

/**
 * Encode a Uint8Array to a Base64 string.
 * @param {Uint8Array} uint8Array
 * @returns {string}
 */
export function toBase64(uint8Array) {
  let binary = ''
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i])
  }
  return btoa(binary)
}

/**
 * Decode a Base64 string to a Uint8Array.
 * @param {string} base64String
 * @returns {Uint8Array}
 */
export function fromBase64(base64String) {
  const binary = atob(base64String)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
