import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseTaskUsage, toLf } from './task-usage.mjs'

const SOURCE = [
  "import { z } from 'zod'",
  '',
  '/**',
  ' * One-off tasks run by the same binary as the app, chosen on the command line:',
  ' *',
  ' *   lyra smoke                 UI smoke test',
  ' *   lyra meeting <mic.wav>     the speaker pipeline',
  ' *     [--offline]              diarize first',
  ' *',
  ' * In development the scripts launch `electron . <task>`.',
  ' */',
  ''
].join('\n')

const EXPECTED = [
  'lyra smoke                 UI smoke test',
  'lyra meeting <mic.wav>     the speaker pipeline',
  '  [--offline]              diarize first'
]

describe('parseTaskUsage', () => {
  it('reads the usage lines from an LF file', () => {
    expect(parseTaskUsage(SOURCE)).toEqual(EXPECTED)
  })

  it('reads the same lines from a CRLF checkout (Windows runners)', () => {
    expect(parseTaskUsage(SOURCE.replaceAll('\n', '\r\n'))).toEqual(EXPECTED)
  })

  it('throws when the block is missing', () => {
    expect(() => parseTaskUsage('/** Something else */\n')).toThrow(/task usage block/)
  })

  it('finds the block in the real args.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const lines = parseTaskUsage(readFileSync(join(here, '../src/main/tasks/args.ts'), 'utf8'))
    expect(lines[0]).toMatch(/^lyra smoke\b/)
  })
})

describe('toLf', () => {
  it('turns CRLF into LF and leaves lone CR and LF alone', () => {
    expect(toLf('a\r\nb\nc\rd')).toBe('a\nb\nc\rd')
  })
})
