import { describe, expect, it } from 'vitest'
import { placeNear } from './placement'

const view = { width: 360, height: 700 }

describe('placeNear', () => {
  it('goes below the anchor when it fits', () => {
    expect(placeNear({ top: 100, bottom: 120, left: 20 }, { width: 320, height: 300 }, view)).toEqual({
      top: 128,
      left: 20
    })
  })

  it('goes above the anchor when there is no room below', () => {
    expect(placeNear({ top: 600, bottom: 620, left: 20 }, { width: 320, height: 300 }, view)).toEqual({
      top: 292,
      left: 20
    })
  })

  it('sits at the bottom of the window when neither side has room', () => {
    // 520 tall under an anchor at 162–178: below ends at 706, above starts at -366.
    expect(placeNear({ top: 162, bottom: 178, left: 20 }, { width: 320, height: 520 }, view)).toEqual({
      top: 172,
      left: 20
    })
  })

  it('never starts above the top margin', () => {
    expect(placeNear({ top: 300, bottom: 320, left: 20 }, { width: 320, height: 684 }, view).top).toBe(8)
  })

  it('keeps the right edge inside the window', () => {
    expect(placeNear({ top: 100, bottom: 120, left: 200 }, { width: 320, height: 100 }, view).left).toBe(32)
    expect(placeNear({ top: 100, bottom: 120, left: 0 }, { width: 520, height: 100 }, view).left).toBe(8)
  })
})
