import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const z = require('./zoom.cjs')

/** A grey frame with a green rectangle outline `thickness` pixels wide. */
function frame(width, height, box, { thickness = 2, color = [100, 244, 0] } = {}) {
  const data = Buffer.alloc(width * height * 3, 90)
  const paint = (x, y) => data.set(color, (y * width + x) * 3)
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const edge = x - box.x0 < thickness || box.x1 - x < thickness || y - box.y0 < thickness || box.y1 - y < thickness
      if (edge) paint(x, y)
    }
  }
  return data
}

describe('findHighlight', () => {
  it('finds the outline of the highlighted tile', () => {
    const box = { x0: 20, y0: 10, x1: 120, y1: 70 }
    expect(z.findHighlight(frame(160, 90, box), 160, 90)).toEqual(box)
  })

  it('finds the darker, thinner border of a small tile', () => {
    const box = { x0: 30, y0: 20, x1: 80, y1: 65 }
    expect(z.findHighlight(frame(160, 90, box, { thickness: 1, color: [38, 163, 0] }), 160, 90)).toEqual(box)
  })

  it('ignores a filled green area: no sides between the two rows', () => {
    const data = Buffer.alloc(160 * 90 * 3, 90)
    for (let y = 10; y < 70; y++) for (let x = 20; x < 120; x++) if (y === 10 || y === 69) data.set([100, 244, 0], (y * 160 + x) * 3)
    expect(z.findHighlight(data, 160, 90)).toBeNull()
  })

  it('returns null on a frame with no green', () => {
    expect(z.findHighlight(Buffer.alloc(160 * 90 * 3, 90), 160, 90)).toBeNull()
  })
})

describe('highlightRuns', () => {
  const a = { x0: 0, y0: 0, x1: 50, y1: 50 }
  const b = { x0: 60, y0: 0, x1: 110, y1: 50 }

  it('joins frames with the same box, boxes a pixel or two apart included', () => {
    const a2 = { ...a, x1: 52 }
    expect(z.highlightRuns([a, a2, b, b], 4)).toEqual([
      { start: 0, end: 0.5, box: a },
      { start: 0.5, end: 1, box: b }
    ])
  })

  it('takes a box seen for one frame as the one before it', () => {
    expect(z.highlightRuns([a, a, b, a, a], 4)).toEqual([{ start: 0, end: 1.25, box: a }])
  })

  it('keeps stretches with no highlight as their own runs', () => {
    expect(z.highlightRuns([a, a, null, null, b, b], 2)).toEqual([
      { start: 0, end: 1, box: a },
      { start: 1, end: 2, box: null },
      { start: 2, end: 3, box: b }
    ])
  })
})

describe('speechRegions', () => {
  it('finds the loud part of quiet audio', () => {
    const rate = 1000
    const samples = new Float32Array(3 * rate).fill(0.001)
    for (let i = rate; i < 2 * rate; i++) samples[i] = i % 2 ? 0.5 : -0.5
    const regions = z.speechRegions(samples, rate)
    expect(regions).toHaveLength(1)
    // 30-sample hops: the hops across 1 s and 2 s are a third and two thirds loud, loud enough.
    expect(regions[0].start).toBeCloseTo(0.99, 5)
    expect(regions[0].end).toBeCloseTo(2.01, 5)
  })
})

describe('estimateLag', () => {
  it('finds how late the border moves after speech starts', () => {
    const box = { x0: 0, y0: 0, x1: 50, y1: 50 }
    const other = { x0: 60, y0: 0, x1: 110, y1: 50 }
    const runs = [
      { start: 0, end: 5.5, box },
      { start: 5.5, end: 10.5, box: other },
      { start: 10.5, end: 20, box }
    ]
    const speech = [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 18 }
    ]
    expect(z.estimateLag(runs, speech)).toEqual({ lag: 0.5, changes: 2, matched: 2 })
  })
})

describe('turns', () => {
  it('moves runs earlier by the lag, cuts them to speech, and skips unnamed or empty runs', () => {
    const box = { x0: 0, y0: 0, x1: 1, y1: 1 }
    const runs = [
      { start: 1, end: 6, box, name: 'Ada' },
      { start: 6, end: 8, box: null },
      { start: 8, end: 12, box, name: null },
      { start: 12, end: 16, box, name: 'Grace' }
    ]
    const speech = [
      { start: 0, end: 3 },
      { start: 4, end: 14 }
    ]
    expect(z.turns(runs, speech, (run) => run.name, 1)).toEqual([
      { speaker: 'Ada', start: 0, end: 3, text: '' },
      { speaker: 'Ada', start: 4, end: 5, text: '' },
      { speaker: 'Grace', start: 11, end: 14, text: '' }
    ])
  })
})

describe('scoredSpans and onKeptTimeline', () => {
  const box = { x0: 0, y0: 0, x1: 1, y1: 1 }

  it('bridges short gaps with no highlight and drops short spans', () => {
    const runs = [
      { start: 0, end: 40, box },
      { start: 40, end: 42, box: null },
      { start: 42, end: 60, box },
      { start: 60, end: 100, box: null },
      { start: 100, end: 110, box }
    ]
    expect(z.scoredSpans(runs)).toEqual([{ start: 0, end: 60 }])
  })

  it('puts turns on a timeline of the kept spans back to back', () => {
    const spans = [
      { start: 10, end: 20 },
      { start: 50, end: 60 }
    ]
    const segments = [
      { speaker: 'a', start: 5, end: 12, text: '' },
      { speaker: 'b', start: 30, end: 40, text: '' },
      { speaker: 'c', start: 55, end: 70, text: '' }
    ]
    expect(z.onKeptTimeline(segments, spans)).toEqual([
      { speaker: 'a', start: 0, end: 2, text: '' },
      { speaker: 'c', start: 15, end: 20, text: '' }
    ])
  })
})

describe('cleanName', () => {
  it('keeps the name before the title, whatever mark OCR read the dash as', () => {
    expect(z.cleanName('Eric Johnson - CTO')).toBe('Eric Johnson')
    expect(z.cleanName('Sid Sijbrandij • CEO ...')).toBe('Sid Sijbrandij')
    expect(z.cleanName('Bryan Wise: V...')).toBe('Bryan Wise')
    expect(z.cleanName('Tanya Pazitny | Qua...')).toBe('Tanya Pazitny')
  })

  it('drops the "..." of a cut-off name and a stray mark before it', () => {
    expect(z.cleanName('Christopher Lefelh...')).toBe('Christopher Lefelh')
    expect(z.cleanName('I Mek Stittri -')).toBe('Mek Stittri')
  })

  it('returns null when nothing like a name is left', () => {
    expect(z.cleanName('...')).toBeNull()
    expect(z.cleanName('')).toBeNull()
  })
})

describe('canonicalNames', () => {
  it('joins misreadings and cut-off names under the longest spelling read twice', () => {
    const readings = [
      'Christopher Lefelh',
      'Christopher Lefelh',
      'Christophey Lefelh',
      'Christopher Le',
      'Christo',
      'Christie Lennev',
      'Christie Lennev',
      'Liy Mai',
      'Liy Mai',
      'uy Mai'
    ]
    const names = z.canonicalNames(readings)
    expect(names.get('Christophey Lefelh')).toBe('Christopher Lefelh')
    expect(names.get('Christopher Le')).toBe('Christopher Lefelh')
    expect(names.get('Christo')).toBe('Christopher Lefelh')
    expect(names.get('Christie Lennev')).toBe('Christie Lennev')
    // "Lily Mai" read as "Liy" and "uy": the same last name, first names two letters apart.
    expect(names.get('uy Mai')).toBe('Liy Mai')
  })

  it('keeps different people with the same first name apart', () => {
    const names = z.canonicalNames(['Steve Loyd', 'Steve Loyd', 'Steve Martin', 'Steve Martin'])
    expect(new Set(names.values())).toEqual(new Set(['Steve Loyd', 'Steve Martin']))
  })
})
