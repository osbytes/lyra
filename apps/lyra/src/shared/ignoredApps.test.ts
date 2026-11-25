import { describe, expect, it } from 'vitest'
import { IgnoredAppsFile, appsInFile, ignoredAppsFile, mergeIgnoredApps } from './ignoredApps'

describe('mergeIgnoredApps', () => {
  it('adds new names, trimmed, and keeps the existing spelling of a duplicate', () => {
    const { apps, added } = mergeIgnoredApps(['Zoom'], [' zoom ', 'Slack', '', '  '])
    expect(apps).toEqual(['Zoom', 'Slack'])
    expect(added).toBe(1)
  })

  it('drops overlong names and stops at the cap', () => {
    const many = Array.from({ length: 600 }, (_, index) => `app-${String(index)}`)
    const { apps, added } = mergeIgnoredApps([], ['x'.repeat(101), ...many])
    expect(apps).toHaveLength(500)
    expect(added).toBe(500)
  })
})

describe('IgnoredAppsFile', () => {
  it('round-trips the exported shape and accepts a bare array', () => {
    const file = IgnoredAppsFile.parse(ignoredAppsFile(['Zoom']))
    expect(appsInFile(file)).toEqual(['Zoom'])
    expect(appsInFile(IgnoredAppsFile.parse(['a', 'b']))).toEqual(['a', 'b'])
  })

  it('rejects another kind of file', () => {
    expect(IgnoredAppsFile.safeParse({ lyra: 'settings', version: 1, apps: [] }).success).toBe(false)
  })
})
