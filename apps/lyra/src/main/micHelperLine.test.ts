import { describe, expect, it } from 'vitest'
import {
  HELPER_MAX_RESTARTS,
  UNKNOWN_APP,
  bundleIdFromPlist,
  helperRestartDelay,
  ownBundleId,
  parseHelperLine
} from './micHelperLine'

const names = (set: Set<string>): string[] => [...set]

describe('parseHelperLine', () => {
  it('reads mic and playing apps, dropping Lyra by exe name', () => {
    const users = parseHelperLine('apps:chrome,electron,Zoom;out:Spotify,electron,Zoom', 'Electron')
    expect(names(users.mic)).toEqual(['chrome', 'Zoom'])
    expect(names(users.playing)).toEqual(['Spotify', 'Zoom'])
  })

  it('reads the macOS yes/no form', () => {
    expect(names(parseHelperLine('1').mic)).toEqual([UNKNOWN_APP])
    expect(parseHelperLine('0').mic.size).toBe(0)
    expect(parseHelperLine('').mic.size).toBe(0)
  })

  it("drops Lyra's own bundle id and its helpers on macOS", () => {
    const own = ownBundleId('com.voicepages.app')
    const users = parseHelperLine(
      'apps:us.zoom.xos,com.voicepages.app.helper,COM.VOICEPAGES.APP.helper.Renderer;out:com.voicepages.app,com.apple.Music',
      own
    )
    expect(names(users.mic)).toEqual(['us.zoom.xos'])
    expect(names(users.playing)).toEqual(['com.apple.Music'])
  })

  it('keeps apps whose ids merely start like Lyra', () => {
    const own = ownBundleId('com.voicepages.app')
    expect(names(parseHelperLine('apps:com.voicepages.application,com.voicepages.apphelper', own).mic)).toEqual([
      'com.voicepages.application',
      'com.voicepages.apphelper'
    ])
  })
})

describe('bundleIdFromPlist', () => {
  it('finds CFBundleIdentifier', () => {
    const xml = '<dict>\n  <key>CFBundleName</key>\n  <string>Lyra</string>\n  <key>CFBundleIdentifier</key>\n  <string>com.voicepages.app</string>\n</dict>'
    expect(bundleIdFromPlist(xml)).toBe('com.voicepages.app')
    expect(bundleIdFromPlist('<dict></dict>')).toBeNull()
  })
})

describe('helperRestartDelay', () => {
  it('backs off and then gives up', () => {
    expect(helperRestartDelay(0)).toBe(2000)
    expect(helperRestartDelay(1)).toBe(4000)
    expect(helperRestartDelay(HELPER_MAX_RESTARTS - 1)).toBe(2000 * 2 ** (HELPER_MAX_RESTARTS - 1))
    expect(helperRestartDelay(HELPER_MAX_RESTARTS)).toBeNull()
  })
})
