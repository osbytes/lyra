import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataChunkBytes, readWav } from './meeting/wav'
import { dataBytesOf, headerRepair, patchHeader, repairSessionAudio, repairWavHeader, wavHeader } from './wavFile'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lyra-wav-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A recorder file as a crash leaves it: header written with no length, audio after it. */
function crashed(samples: number): Buffer {
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(1000, i * 2)
  return Buffer.concat([wavHeader(0), pcm])
}

describe('dataChunkBytes', () => {
  it('reads to the end of the file when the header was never finalised', () => {
    expect(dataChunkBytes(0, 32000)).toBe(32000)
    expect(dataChunkBytes(64000, 32000)).toBe(32000)
  })

  it('trusts a header that fits, so trailing chunks are not read as audio', () => {
    expect(dataChunkBytes(16000, 32000)).toBe(16000)
  })
})

describe('header repair', () => {
  it('drops a torn last byte and leaves a correct header alone', () => {
    expect(dataBytesOf(44 + 101)).toBe(100)
    expect(dataBytesOf(10)).toBe(0)
    expect(headerRepair(wavHeader(100), 44 + 100)).toBeNull()
    expect(headerRepair(wavHeader(0), 44 + 101)).toBe(100)
  })

  it('ignores files that are not in the recorder layout', () => {
    const other = Buffer.from(wavHeader(0))
    other.write('LIST', 36, 'ascii')
    expect(headerRepair(other, 1000)).toBeNull()
    expect(headerRepair(Buffer.alloc(10), 1000)).toBeNull()
  })

  it('makes a crashed recording readable, and the reader copes before the repair', async () => {
    const path = join(dir, 'mic.wav')
    await writeFile(path, crashed(16000))
    expect((await readWav(path)).length).toBe(16000)
    expect(await repairWavHeader(path)).toBe(true)
    expect(await repairWavHeader(path)).toBe(false)
    const header = await readFile(path)
    expect(header.readUInt32LE(40)).toBe(32000)
    expect(header.readUInt32LE(4)).toBe(36 + 32000)
    expect((await readWav(path)).length).toBe(16000)
  })

  it('patches the header in place without touching the audio', async () => {
    const path = join(dir, 'mic.wav')
    await writeFile(path, crashed(800))
    await patchHeader(path, 1600)
    const file = await readFile(path)
    expect(file.readUInt32LE(40)).toBe(1600)
    expect(file.length).toBe(44 + 1600)
    expect(file.readInt16LE(44)).toBe(1000)
  })

  it('walks session folders, skipping the one recording and dot folders', async () => {
    const { mkdir } = await import('node:fs/promises')
    for (const id of ['a.txt', 'b.txt', '.trash']) {
      await mkdir(join(dir, id, 'audio'), { recursive: true })
      await writeFile(join(dir, id, 'audio', 'mic.wav'), crashed(100))
    }
    const result = await repairSessionAudio(dir, (id) => id === 'b.txt')
    expect(result).toEqual({ checked: 1, files: 1, failed: 0, repaired: ['a.txt'] })
    expect((await readFile(join(dir, 'b.txt', 'audio', 'mic.wav'))).readUInt32LE(40)).toBe(0)
  })
})
