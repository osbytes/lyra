import { describe, expect, it } from 'vitest'
import { modelLine } from './modelStatusText'

const base = { feature: 'semanticSearch', model: 'nomic.gguf' } as const

describe('modelLine', () => {
  it('shows download percent and size, with Cancel', () => {
    const line = modelLine({ ...base, state: 'downloading', received: 42 * 1024 * 1024, total: 100 * 1024 * 1024 })
    expect(line.text).toBe('Downloading 42% · 42.0 MB of 100 MB')
    expect(line.action).toBe('cancel')
    expect(line.progress).toBeCloseTo(0.42)
  })

  it('rounds the percent down, so 100% means done', () => {
    expect(modelLine({ ...base, state: 'downloading', received: 999, total: 1000 }).text).toMatch(/^Downloading 99%/)
  })

  it('counts sessions being read, and says when that waits', () => {
    expect(modelLine({ ...base, state: 'reading', done: 120, total: 300, pausedFor: null }).text).toBe(
      'Reading your sessions 120/300'
    )
    expect(modelLine({ ...base, state: 'reading', done: 120, total: 300, pausedFor: 'battery' }).text).toBe(
      'Reading your sessions 120/300 · paused on battery'
    )
    const loading = modelLine({ ...base, state: 'reading', done: 0, total: 0, pausedFor: null })
    expect(loading.text).toBe('Reading your sessions…')
    expect(loading.progress).toBeNull()
  })

  it('offers Retry after a failure or a cancel, and nothing once ready', () => {
    const failed = modelLine({ ...base, state: 'error', message: 'Download failed (HTTP 503)' })
    expect(failed).toMatchObject({ tone: 'error', action: 'retry' })
    expect(failed.text).toContain('HTTP 503')
    expect(
      modelLine({ ...base, state: 'error', message: 'Download failed (HTTP 404) for http://127.0.0.1:9399/a/b.gguf' }).text
    ).toBe('Couldn’t set it up: Download failed (HTTP 404)')
    expect(modelLine({ ...base, state: 'cancelled' }).action).toBe('retry')
    expect(modelLine({ ...base, state: 'ready' })).toMatchObject({ text: 'Ready', action: null })
    expect(modelLine({ ...base, state: 'missing' }).action).toBe('download')
  })
})
