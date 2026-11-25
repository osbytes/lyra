import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSessionsDir, isNoteName, noteInRoot } from './notePath'

describe('isNoteName', () => {
  it('takes plain .txt and .md names in any case', () => {
    for (const name of ['2026-01-02_03-04-05.txt', 'Meeting notes.md', 'NOTE.TXT', 'console.txt', 'com10.txt']) {
      expect(isNoteName(name), name).toBe(true)
    }
  })

  it('refuses separators, traversal, hidden files and other extensions', () => {
    for (const name of ['../escape.txt', '..\\escape.txt', 'x/y.txt', 'x\\y.txt', '.hidden.txt', 'a..txt', 'note.exe', 'note.txt.exe', '']) {
      expect(isNoteName(name), name).toBe(false)
    }
  })

  it('refuses alternate data streams, drive-relative names and control characters', () => {
    for (const name of ['note.txt:secret.txt', 'C:note.txt', 'c:..\\x.txt', 'line\nbreak.txt', 'tab\there.md', 'nul\u0000.txt', 'del\u007f.md']) {
      expect(isNoteName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it('refuses Windows device names with or without more extensions', () => {
    for (const name of ['CON.txt', 'con.md', 'Nul.txt', 'aux.notes.md', 'PRN .txt', 'COM1.txt', 'lpt9.md', 'COM¹.txt']) {
      expect(isNoteName(name), name).toBe(false)
    }
  })

  it('refuses trailing dots and spaces', () => {
    for (const name of ['note.txt.', 'note.txt ', 'note.md...']) expect(isNoteName(name), name).toBe(false)
  })
})

describe('noteInRoot', () => {
  it('resolves a note directly inside the root (POSIX)', () => {
    expect(noteInRoot('/home/me/.lyra', 'a.txt', path.posix)).toBe('/home/me/.lyra/a.txt')
  })

  it('resolves a note directly inside the root (Windows)', () => {
    expect(noteInRoot('C:\\Users\\me\\.lyra', 'a.txt', path.win32)).toBe('C:\\Users\\me\\.lyra\\a.txt')
    expect(noteInRoot('\\\\server\\share\\notes', 'a.md', path.win32)).toBe('\\\\server\\share\\notes\\a.md')
  })

  it('refuses ids that would leave the root on either platform', () => {
    const bad = ['../a.txt', '..\\a.txt', 'C:a.txt', 'C:\\a.txt', '\\\\server\\share\\a.txt', '/etc/a.txt', 'sub/a.txt', 'CON.txt', 42, null, undefined, { id: 'a.txt' }]
    for (const id of bad) {
      expect(() => noteInRoot('C:\\notes', id, path.win32), JSON.stringify(id)).toThrow('Invalid page id')
      expect(() => noteInRoot('/notes', id, path.posix), JSON.stringify(id)).toThrow('Invalid page id')
    }
  })

  it('does not put the id in the error', () => {
    expect(() => noteInRoot('/notes', '../private name.txt', path.posix)).toThrow(/^Invalid page id$/)
  })
})

describe('checkSessionsDir', () => {
  const made: string[] = []
  const tempRoot = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lyra-notepath-'))
    made.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a missing or real .sessions folder', () => {
    const root = tempRoot()
    expect(() => checkSessionsDir(root)).not.toThrow()
    mkdirSync(path.join(root, '.sessions'))
    expect(() => checkSessionsDir(root)).not.toThrow()
  })

  it('refuses a .sessions that is a file', () => {
    const root = tempRoot()
    writeFileSync(path.join(root, '.sessions'), '')
    expect(() => checkSessionsDir(root)).toThrow(/link or not a folder/)
  })

  it.skipIf(process.platform === 'win32')('refuses a .sessions that is a symlink', () => {
    const root = tempRoot()
    const elsewhere = tempRoot()
    symlinkSync(elsewhere, path.join(root, '.sessions'), 'dir')
    expect(() => checkSessionsDir(root)).toThrow(/link or not a folder/)
  })
})
