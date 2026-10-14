/**
 * Chrome native messaging stdio framing: a 4-byte little-endian length
 * followed by that many bytes of UTF-8 JSON.
 *
 * Chrome caps host-to-extension messages at 1 MB but lets the extension send
 * far more, so the reader has to cope with a bundle arriving as many chunks,
 * and with several frames landing in one chunk.
 */

/** Chrome's limit on a message the host sends back to the extension. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

/** Refuse absurd incoming lengths rather than allocating on a bad header. */
export const MAX_INCOMING_BYTES = 512 * 1024 * 1024;

export type Frame =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** Encode a value as one length-prefixed frame. */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental reader. Feed it chunks; it hands back every complete frame it
 * can make from what it has so far. A frame whose body is not JSON comes back
 * as `{ ok: false }` rather than throwing, so the host can answer and keep
 * reading the next one.
 */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  #fatal: string | null = null;

  push(chunk: Buffer): Frame[] {
    if (this.#fatal) return [{ ok: false, error: this.#fatal }];
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const frames: Frame[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_INCOMING_BYTES) {
        // The stream is desynchronised; nothing after this can be trusted.
        this.#fatal = `frame length ${length} exceeds the ${MAX_INCOMING_BYTES} byte limit`;
        frames.push({ ok: false, error: this.#fatal });
        this.#buffer = Buffer.alloc(0);
        break;
      }
      if (this.#buffer.length < 4 + length) break;

      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        frames.push({ ok: true, value: JSON.parse(body.toString('utf8')) });
      } catch (err) {
        frames.push({ ok: false, error: `frame is not JSON: ${(err as Error).message}` });
      }
    }
    return frames;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.#buffer.length;
  }
}
