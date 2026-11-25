import { describe, expect, it } from 'vitest'
import { WindowState, fitToScreens } from './windowBounds'

const MIN = { width: 760, height: 520 }
const LAPTOP = { x: 0, y: 25, width: 1440, height: 875 }
const RIGHT = { x: 1440, y: 0, width: 1920, height: 1080 }

describe('fitToScreens', () => {
  it('keeps a window that fits', () => {
    const saved = { x: 100, y: 100, width: 1080, height: 720 }
    expect(fitToScreens(saved, [LAPTOP], MIN)).toEqual(saved)
  })

  it('pulls a window hanging off the edge back inside', () => {
    expect(fitToScreens({ x: 1000, y: 600, width: 1080, height: 720 }, [LAPTOP], MIN)).toEqual({
      x: 360,
      y: 180,
      width: 1080,
      height: 720
    })
  })

  it('shrinks a window bigger than the screen', () => {
    expect(fitToScreens({ x: 0, y: 0, width: 3000, height: 2000 }, [LAPTOP], MIN)).toEqual(LAPTOP)
  })

  it('puts the window on the screen it mostly sits on', () => {
    expect(fitToScreens({ x: 2000, y: 100, width: 1080, height: 720 }, [LAPTOP, RIGHT], MIN)).toEqual({
      x: 2000,
      y: 100,
      width: 1080,
      height: 720
    })
  })

  it('gives up on a window left on an unplugged screen', () => {
    expect(fitToScreens({ x: 2000, y: 100, width: 1080, height: 720 }, [LAPTOP], MIN)).toBeNull()
    // A corner a few pixels square is lost too; a sliver down a whole side is pulled back.
    expect(fitToScreens({ x: 1430, y: 890, width: 1080, height: 720 }, [LAPTOP], MIN)).toBeNull()
    expect(fitToScreens({ x: 1420, y: 100, width: 1080, height: 720 }, [LAPTOP], MIN)?.x).toBe(360)
    expect(fitToScreens({ x: 0, y: 0, width: 800, height: 600 }, [], MIN)).toBeNull()
  })

  it('grows a too-small saved size back to the minimum', () => {
    expect(fitToScreens({ x: 10, y: 30, width: 100, height: 100 }, [LAPTOP], MIN)).toEqual({ x: 10, y: 30, width: 760, height: 520 })
  })
})

describe('WindowState', () => {
  it('refuses junk from disk', () => {
    expect(WindowState.safeParse({ x: 1, y: 2, width: 3, height: 4, maximized: false }).success).toBe(true)
    expect(WindowState.safeParse({ x: 1, y: 2, width: -3, height: 4, maximized: false }).success).toBe(false)
    expect(WindowState.safeParse({ x: 'a', y: 2, width: 3, height: 4, maximized: false }).success).toBe(false)
    expect(WindowState.safeParse(null).success).toBe(false)
  })
})
