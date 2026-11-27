import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parseRttm, clip } = require('./voxconverse.cjs')

describe('parseRttm', () => {
  it('reads SPEAKER lines as turns in time order, start plus duration as the end', () => {
    const text = [
      'SPEAKER aepyx 1 6.20000 5.34000 <NA> <NA> spk01 <NA> <NA>',
      'SPEAKER aepyx 1 2.50000 3.66000 <NA> <NA> spk00 <NA> <NA>'
    ].join('\r\n')
    expect(parseRttm(text)).toEqual([
      { speaker: 'spk00', start: 2.5, end: 6.16, text: '' },
      { speaker: 'spk01', start: 6.2, end: 11.54, text: '' }
    ])
  })

  it('skips other record types, blank lines and empty or malformed turns', () => {
    const text = [
      'SPKR-INFO aepyx 1 <NA> <NA> <NA> unknown spk00 <NA> <NA>',
      '',
      'SPEAKER aepyx 1 1.0 0 <NA> <NA> spk00 <NA> <NA>',
      'SPEAKER aepyx 1 x 2.0 <NA> <NA> spk00 <NA> <NA>',
      'SPEAKER aepyx 1 3.0 1.0 <NA> <NA> spk02 <NA> <NA>'
    ].join('\n')
    expect(parseRttm(text)).toEqual([{ speaker: 'spk02', start: 3, end: 4, text: '' }])
  })
})

describe('clip', () => {
  it('drops turns from the cut on and shortens the one across it', () => {
    const turns = [
      { speaker: 'a', start: 0, end: 5, text: '' },
      { speaker: 'b', start: 8, end: 12, text: '' },
      { speaker: 'a', start: 10, end: 11, text: '' }
    ]
    expect(clip(turns, 10)).toEqual([
      { speaker: 'a', start: 0, end: 5, text: '' },
      { speaker: 'b', start: 8, end: 10, text: '' }
    ])
  })
})
