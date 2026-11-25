import { beforeEach, describe, expect, it } from 'vitest'
import { MeetingDetector, type DetectorPolicy } from './meetingDetector'

const POLICY: DetectorPolicy = { meetings: true, anyApp: false, recording: false, ignored: () => false }

/** A detector on a fake clock, and a helper to feed it one update at a time. */
function setup(options: { maxTitleChecks?: number } = {}) {
  const clock = { now: 0 }
  const titles: { list: string[]; reads: number } = { list: [], reads: 0 }
  const detector = new MeetingDetector({
    now: () => clock.now,
    titles: () => {
      titles.reads++
      return Promise.resolve(titles.list)
    },
    sustainMs: 2000,
    snoozeMs: 60_000,
    maxTitleChecks: options.maxTitleChecks ?? 2,
    callWaitMs: 30_000
  })
  const at = async (
    time: number,
    mic: string[],
    over: Partial<DetectorPolicy> = {},
    playing: string[] = []
  ): Promise<string | null> => {
    clock.now = time
    const target = await detector.update({ mic: new Set(mic), playing: new Set(playing) }, { ...POLICY, ...over })
    return target?.key ?? null
  }
  return { detector, clock, titles, at }
}

describe('MeetingDetector', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('stays quiet about a call already running when watching starts', async () => {
    expect(await t.at(0, ['Zoom'])).toBeNull()
    expect(await t.at(5000, ['Zoom'])).toBeNull()
    // Once it lets go, the next use counts.
    await t.at(6000, [])
    await t.at(7000, ['Zoom'])
    expect(await t.at(9000, ['Zoom'])).toBe('zoom')
  })

  it('asks once per use, after the mic is held for the sustain time', async () => {
    await t.at(0, [])
    expect(await t.at(1000, ['Zoom'])).toBeNull()
    expect(await t.at(2500, ['Zoom'])).toBeNull()
    expect(await t.at(3000, ['Zoom'])).toBe('zoom')
    expect(await t.at(10_000, ['Zoom'])).toBeNull()
  })

  it('wants a timed look while a new user waits, and none once settled', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom'])
    expect(t.detector.nextCheckAt()).toBe(3000)
    await t.at(3000, ['Zoom'])
    expect(t.detector.nextCheckAt()).toBeNull()
  })

  it('keeps a snoozed meeting quiet until the snooze ends', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom'])
    expect(await t.at(3000, ['Zoom'])).toBe('zoom')
    t.detector.snooze('zoom')
    await t.at(4000, [])
    await t.at(5000, ['Zoom'])
    expect(await t.at(8000, ['Zoom'])).toBeNull()
    await t.at(70_000, [])
    await t.at(71_000, ['Zoom'])
    expect(await t.at(74_000, ['Zoom'])).toBe('zoom')
  })

  it('never asks while recording, nor about a call that was recorded', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom'])
    expect(await t.at(3000, ['Zoom'], { recording: true })).toBeNull()
    expect(await t.at(4000, ['Zoom'])).toBeNull()
  })

  it('asks about nothing with both prompts off', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom', 'obs64'])
    expect(await t.at(3000, ['Zoom', 'obs64'], { meetings: false, anyApp: false })).toBeNull()
  })

  it('respects "Don\'t ask" by label', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom'])
    expect(await t.at(3000, ['Zoom'], { ignored: (label) => label === 'Zoom' })).toBeNull()
  })

  it('reads a browser title until a meeting shows, up to the limit', async () => {
    await t.at(0, [])
    await t.at(1000, ['chrome'])
    expect(await t.at(3000, ['chrome'])).toBeNull()
    t.titles.list = ['Meet - abc-defg-hij - Google Chrome']
    expect(await t.at(4000, ['chrome'])).toBe('meet')
    await t.at(5000, [])
    t.titles.list = []
    await t.at(6000, ['chrome'])
    await t.at(8000, ['chrome'])
    await t.at(9000, ['chrome'])
    const reads = t.titles.reads
    t.titles.list = ['Meet - abc-defg-hij - Google Chrome']
    expect(await t.at(10_000, ['chrome'])).toBeNull()
    expect(t.titles.reads).toBe(reads)
  })

  it('offers a browser as a plain mic user in any-app mode when meetings are off', async () => {
    await t.at(0, [])
    await t.at(1000, ['chrome'])
    expect(await t.at(3000, ['chrome'], { meetings: false, anyApp: true })).toBe('chrome')
    expect(t.titles.reads).toBe(0)
  })

  it('takes an unlisted app on the mic and playing sound for a call', async () => {
    await t.at(0, [])
    await t.at(1000, ['Element'], {}, ['Element'])
    expect(await t.at(2000, ['Element'], {}, ['Element'])).toBeNull()
    expect(await t.at(3000, ['Element'], {}, ['Element'])).toBe('element')
  })

  it('needs sound to have played for the sustain time, not just the mic', async () => {
    await t.at(0, [])
    await t.at(1000, ['Element'])
    expect(await t.at(4000, ['Element'], {}, ['Element'])).toBeNull()
    expect(await t.at(6000, ['Element'], {}, ['Element'])).toBe('element')
  })

  it('gives up waiting for sound after the call wait', async () => {
    await t.at(0, [])
    await t.at(1000, ['Wispr Flow'])
    expect(await t.at(3000, ['Wispr Flow'])).toBeNull()
    expect(await t.at(40_000, ['Wispr Flow'])).toBeNull()
    await t.at(41_000, ['Wispr Flow'], {}, ['Wispr Flow'])
    expect(await t.at(44_000, ['Wispr Flow'], {}, ['Wispr Flow'])).toBeNull()
  })

  it('does not take recorders or a playing browser for a call', async () => {
    await t.at(0, [])
    await t.at(1000, ['obs64', 'chrome'], {}, ['obs64', 'chrome'])
    t.titles.list = ['YouTube - Google Chrome']
    expect(await t.at(3000, ['obs64', 'chrome'], {}, ['obs64', 'chrome'])).toBeNull()
    expect(await t.at(6000, ['obs64', 'chrome'], {}, ['obs64', 'chrome'])).toBeNull()
  })

  it('asks about any app in any-app mode', async () => {
    await t.at(0, [])
    await t.at(1000, ['obs64'])
    expect(await t.at(3000, ['obs64'], { anyApp: true })).toBe('obs64')
  })

  it('forgets everything on reset, so users present then are skipped again', async () => {
    await t.at(0, [])
    await t.at(1000, ['Zoom'])
    t.detector.reset()
    expect(await t.at(2000, ['Zoom'])).toBeNull()
    expect(await t.at(5000, ['Zoom'])).toBeNull()
  })

  it('names the meeting from the list, not the raw process name', async () => {
    await t.at(0, [])
    await t.at(1000, ['us.zoom.xos'])
    expect(await t.at(3000, ['us.zoom.xos'])).toBe('zoom')
  })
})
