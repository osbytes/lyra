import * as Y from 'yjs'

/**
 * `doc.yjs`: a session document as an append-only log of Yjs updates. Pure (no Electron), so
 * the framing and recovery rules can be unit-tested.
 */

/** One frame: a 4-byte little-endian length, then the update. */
export function frame(update: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + update.byteLength)
  out.writeUInt32LE(update.byteLength, 0)
  Buffer.from(update.buffer, update.byteOffset, update.byteLength).copy(out, 4)
  return out
}

export type ReadFrames = {
  frames: Uint8Array[]
  /** Bytes up to the end of the last whole frame; anything after it is a torn write. */
  end: number
}

export function readFrames(buffer: Uint8Array): ReadFrames {
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const frames: Uint8Array[] = []
  let offset = 0
  while (offset + 4 <= view.byteLength) {
    const length = view.readUInt32LE(offset)
    const end = offset + 4 + length
    // A torn last frame (crash mid-write) is dropped; everything before it is intact.
    if (end > view.byteLength) break
    frames.push(new Uint8Array(view.subarray(offset + 4, end)))
    offset = end
  }
  return { frames, end: offset }
}

export type LoadedLog = {
  /** Frames applied to the document. */
  applied: number
  /**
   * The log held bytes that weren't applied: a torn tail, or a frame Yjs couldn't read (and
   * everything after it). The document holds what came before; the log needs rewriting.
   */
  damaged: boolean
}

/**
 * Applies a log to `doc` in one transaction. A frame that throws stops it there, keeping what
 * was applied, rather than leaving the whole session unopenable.
 */
export function applyLog(doc: Y.Doc, bytes: Uint8Array, origin: unknown): LoadedLog {
  const { frames, end } = readFrames(bytes)
  let applied = 0
  doc.transact(() => {
    for (const update of frames) {
      try {
        Y.applyUpdate(doc, update)
      } catch {
        return
      }
      applied++
    }
  }, origin)
  return { applied, damaged: end < bytes.byteLength || applied < frames.length }
}
