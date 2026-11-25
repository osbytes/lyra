import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { corruptCopyPath, readSettingsFile, settingsForDisk } from './settingsFile'

const dir = (): string => mkdtempSync(join(tmpdir(), 'lyra-settings-'))

describe('readSettingsFile', () => {
  it('tells a missing file apart from a bad one', () => {
    expect(readSettingsFile(join(dir(), 'settings.json'))).toEqual({ kind: 'missing' })
  })

  it('copies an unparseable file aside before defaults replace it', () => {
    const root = dir()
    const path = join(root, 'settings.json')
    writeFileSync(path, '{"hotkey": ')
    const read = readSettingsFile(path)
    expect(read.kind).toBe('corrupt')
    if (read.kind !== 'corrupt' || !read.aside) throw new Error('expected a copy')
    expect(readFileSync(read.aside, 'utf8')).toBe('{"hotkey": ')
    expect(readdirSync(root).some((name) => /^settings\.corrupt-.+\.json$/.test(name))).toBe(true)
    expect(existsSync(path)).toBe(true)
  })

  it('treats a non-object as corrupt', () => {
    const path = join(dir(), 'settings.json')
    writeFileSync(path, '[1, 2]')
    expect(readSettingsFile(path).kind).toBe('corrupt')
  })

  it('names the copy settings.corrupt-<time>.json', () => {
    expect(corruptCopyPath('/u/settings.json', new Date('2026-11-25T01:02:03.004Z'))).toBe(
      join('/u', 'settings.corrupt-2026-11-25T01-02-03-004Z.json')
    )
  })
})

describe('settingsForDisk', () => {
  it('keeps keys this build does not know, under the ones it does', () => {
    const stored = { hotkey: 'old', fromTheFuture: { on: true } }
    expect(settingsForDisk(stored, { hotkey: 'new' })).toEqual({ hotkey: 'new', fromTheFuture: { on: true } })
  })
})
