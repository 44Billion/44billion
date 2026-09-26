// Simple frame/byte credit window used in both directions of the dedicated
// relay bridge port. The sender queues locally once credits run out, so a slow
// or busy peer can never make the other side buffer without bound.
export class CreditWindow {
  #frames
  #bytes

  constructor ({ frames, bytes }) {
    this.#frames = frames
    this.#bytes = bytes
  }

  canSend (size) {
    return this.#frames > 0 && this.#bytes >= size
  }

  consume (size) {
    this.#frames--
    this.#bytes -= size
  }

  grant (frames, bytes) {
    this.#frames += frames
    this.#bytes += bytes
  }
}

export function frameSize (data) {
  if (typeof data === 'string') return data.length
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size
  return 0
}
