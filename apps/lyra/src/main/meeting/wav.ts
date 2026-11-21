import { open } from 'node:fs/promises'

/** Lyra's meeting recordings: 16 kHz, mono, 16-bit PCM WAV. */
export const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

type WavInfo = { dataOffset: number; samples: number }

async function readInfo(path: string): Promise<WavInfo> {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    let offset = 12
    while (offset + 8 <= bytesRead) {
      const id = header.toString('ascii', offset, offset + 4)
      const size = header.readUInt32LE(offset + 4)
      if (id === 'data') {
        const { size: fileSize } = await handle.stat()
        const available = Math.max(0, fileSize - (offset + 8))
        return { dataOffset: offset + 8, samples: Math.floor(Math.min(size, available) / BYTES_PER_SAMPLE) }
      }
      offset += 8 + size + (size % 2)
    }
    throw new Error(`No audio data in ${path}`)
  } finally {
    await handle.close()
  }
}

/** Reads samples [startSec, endSec) as floats in [-1, 1]; the whole file when no range is given. */
export async function readWav(path: string, startSec = 0, endSec = Infinity): Promise<Float32Array> {
  const info = await readInfo(path)
  const first = Math.max(0, Math.min(info.samples, Math.floor(startSec * SAMPLE_RATE)))
  const last = Math.max(first, Math.min(info.samples, Math.ceil(endSec * SAMPLE_RATE)))
  const count = last - first
  const bytes = Buffer.alloc(count * BYTES_PER_SAMPLE)
  const handle = await open(path, 'r')
  try {
    await handle.read(bytes, 0, bytes.length, info.dataOffset + first * BYTES_PER_SAMPLE)
  } finally {
    await handle.close()
  }
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(i * BYTES_PER_SAMPLE) / 32768
  return out
}

/** Sums two tracks sample by sample, clamped; the shorter one is padded with silence. */
export function mixTracks(a: Float32Array, b: Float32Array | null): Float32Array {
  if (!b) return a
  const out = new Float32Array(Math.max(a.length, b.length))
  for (let i = 0; i < out.length; i++) {
    const sum = (a[i] ?? 0) + (b[i] ?? 0)
    out[i] = sum > 1 ? 1 : sum < -1 ? -1 : sum
  }
  return out
}

export function energy(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i++) {
    const value = samples[i] ?? 0
    sum += value * value
  }
  return sum
}
