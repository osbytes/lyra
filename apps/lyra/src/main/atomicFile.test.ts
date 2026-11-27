import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempPathFor, writeFileAtomic, writeFileAtomicSync } from './atomicFile'

const dir = (): string => mkdtempSync(join(tmpdir(), 'lyra-atomic-'))

describe('atomic writes', () => {
  it('replaces the file and leaves no temp file behind', async () => {
    const root = dir()
    const path = join(root, 'note.txt')
    writeFileSync(path, 'old')
    await writeFileAtomic(path, 'new')
    writeFileAtomicSync(join(root, 'doc.json'), new Uint8Array([1, 2, 3]))
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect([...readFileSync(join(root, 'doc.json'))]).toEqual([1, 2, 3])
    expect(readdirSync(root).sort()).toEqual(['doc.json', 'note.txt'])
  })

  it('never interleaves overlapping writes of one file', async () => {
    const root = dir()
    const path = join(root, 'settings.json')
    const values = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(5000 * i) }))
    await Promise.all(values.map((value) => writeFileAtomic(path, value)))
    expect(values).toContain(readFileSync(path, 'utf8'))
    expect(readdirSync(root)).toEqual(['settings.json'])
  })

  it('uses a hidden, unique temp name that is not a note', () => {
    const a = basename(tempPathFor('/notes/a.txt'))
    const b = basename(tempPathFor('/notes/a.txt'))
    expect(a).not.toBe(b)
    expect(a.startsWith('.a.txt.')).toBe(true)
    expect(a.endsWith('.tmp')).toBe(true)
  })
})
