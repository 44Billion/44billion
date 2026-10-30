import { initNostrWasm } from 'nostr-wasm'
import { isSerializableEvent, isValidEvent as verifyWithJavaScript } from 'libp2r2p/event'

const HEX_32 = /^[0-9a-f]{64}$/
const HEX_64 = /^[0-9a-f]{128}$/

// Initialization is awaited by importing modules before they consume events.
// The embedded binary needs neither a network request nor a separate asset.
export async function createEventVerifier (initialize = initNostrWasm) {
  let wasm
  try { wasm = await initialize() } catch { /* Keep verification available without WASM. */ }
  return {
    backend: wasm ? 'wasm' : 'javascript',
    verifyEvent (event) {
      try {
        // The WASM wrapper assumes correctly sized hex inputs. Keep the library's
        // strict shape checks, including safe integers and nonempty string tags.
        if (!isSerializableEvent(event) || typeof event.id !== 'string' || !HEX_32.test(event.id) || typeof event.sig !== 'string' || !HEX_64.test(event.sig)) return false
        // nostr-wasm has a fixed heap. Keep large payloads on the JS path;
        // this conservative UTF-16 budget also bounds UTF-8 expansion.
        const characters = event.content.length + event.tags.reduce((sum, tag) => sum + tag.reduce((size, value) => size + value.length + 4, 2), 0)
        if (!wasm || characters > 256 * 1024) return verifyWithJavaScript(event)
        wasm.verifyEvent(event) // Throws on a mismatched ID or invalid signature.
        return true
      } catch { return false }
    }
  }
}

const verifier = await createEventVerifier()
export const verificationBackend = verifier.backend
export const verifyEvent = verifier.verifyEvent
