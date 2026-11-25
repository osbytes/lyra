import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The WAV layout Lyra records: a fixed 44-byte header (RIFF, fmt, data) and 16 kHz mono 16-bit
 * PCM after it. No Electron here, so the header maths is unit-tested and the startup repair can
 * run before any window exists.
 */

export const SAMPLE_RATE = 16000
export const BYTES_PER_SECOND = SAMPLE_RATE * 2
export const HEADER_BYTES = 44

export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/** The audio bytes a file of `fileSize` holds: whole samples only, so a torn last write is dropped. */
export function dataBytesOf(fileSize: number): number {
  const data = Math.max(0, fileSize - HEADER_BYTES)
  return data - (data % 2)
}

/**
 * The data size a header should carry for a file of `fileSize`, or null when it already does.
 * Only Lyra's own layout (the data chunk right after a 16-byte fmt chunk) is touched: anything
 * else wasn't written by the recorder and is left alone.
 */
export function headerRepair(header: Buffer, fileSize: number): number | null {
  if (header.length < HEADER_BYTES) return null
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null
  if (header.toString('ascii', 12, 16) !== 'fmt ' || header.readUInt32LE(16) !== 16) return null
  if (header.toString('ascii', 36, 40) !== 'data') return null
  const expected = dataBytesOf(fileSize)
  const riff = header.readUInt32LE(4)
  return header.readUInt32LE(40) === expected && riff === 36 + expected ? null : expected
}

/**
 * Writes the header for `dataBytes` of audio in place. Positional, on its own handle, so it can
 * run while the recorder's stream is still appending: the stream never touches the first 44 bytes.
 */
export async function patchHeader(path: string, dataBytes: number): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.write(wavHeader(dataBytes), 0, HEADER_BYTES, 0)
  } finally {
    await handle.close()
  }
}

/** Rewrites a recorder WAV's header when it disagrees with the file's length; true if it did. */
export async function repairWavHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r+')
  try {
    const header = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
    const { size } = await handle.stat()
    const fixed = headerRepair(header.subarray(0, bytesRead), size)
    if (fixed === null) return false
    await handle.write(wavHeader(fixed), 0, HEADER_BYTES, 0)
    return true
  } finally {
    await handle.close()
  }
}

/**
 * Repairs the headers of every session's tracks under `root` (`.sessions/<id>/audio/*.wav`).
 * A recording cut short by a crash or power loss keeps its audio but not its final header, so
 * other players would see an empty file. `skip` names a session still recording.
 */
export async function repairSessionAudio(
  root: string,
  skip: (id: string) => boolean
): Promise<{ checked: number; files: number; failed: number; repaired: string[] }> {
  const repairedSessions: string[] = []
  const counts = { checked: 0, files: 0, failed: 0, repaired: repairedSessions }
  const sessions = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const session of sessions) {
    if (!session.isDirectory() || session.name.startsWith('.') || skip(session.name)) continue
    const dir = join(root, session.name, 'audio')
    const files = await readdir(dir).catch(() => [])
    let repaired = false
    for (const file of files) {
      if (!file.endsWith('.wav')) continue
      counts.checked++
      try {
        if (await repairWavHeader(join(dir, file))) {
          counts.files++
          repaired = true
        }
      } catch {
        counts.failed++
      }
    }
    if (repaired) counts.repaired.push(session.name)
  }
  return counts
}
