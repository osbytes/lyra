import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DELAY_MS,
  activityFace,
  bytesDetail,
  DONE_LINGER_MS,
  expired,
  newEndings,
  visibleActivity,
  type ActivityItem
} from './activity'

function item(patch: Partial<ActivityItem> & Pick<ActivityItem, 'id'>): ActivityItem {
  return {
    kind: 'model',
    state: 'running',
    origin: 'settings',
    title: 'Downloading the search model',
    detail: null,
    pageId: null,
    progress: null,
    actions: [],
    startedAt: 0,
    endedAt: null,
    seenAt: null,
    ...patch
  }
}

describe('visibleActivity', () => {
  it('waits before showing quick work, and puts failures first', () => {
    const quick = item({ id: 'quick', startedAt: 10_000 })
    const slow = item({ id: 'slow', startedAt: 0 })
    const failed = item({ id: 'failed', state: 'failed', startedAt: 5_000, endedAt: 9_000 })
    const shown = visibleActivity([quick, slow, failed], 10_000 + ACTIVITY_DELAY_MS - 1)
    expect(shown.map((entry) => entry.id)).toEqual(['failed', 'slow'])
  })

  it('keeps a done item until it has been seen for a moment', () => {
    const unseen = item({ id: 'a', state: 'done', endedAt: 1 })
    const seen = item({ id: 'b', state: 'done', endedAt: 1, seenAt: 1000 })
    expect(visibleActivity([unseen, seen], 1000 + DONE_LINGER_MS - 1).map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(visibleActivity([unseen, seen], 1000 + DONE_LINGER_MS).map((entry) => entry.id)).toEqual(['a'])
    expect(expired(seen, 1000 + DONE_LINGER_MS)).toBe(true)
  })

  it('never lets a seen failure expire', () => {
    const failed = item({ id: 'f', state: 'failed', endedAt: 1, seenAt: 1 })
    expect(visibleActivity([failed], 1e9)).toHaveLength(1)
  })
})

describe('activityFace', () => {
  it('shows a failure over progress, and the count of what needs you', () => {
    const running = item({ id: 'r', progress: 0.42 })
    const failed = item({ id: 'f', state: 'failed' })
    expect(activityFace([failed, running])).toEqual({ tone: 'attention', label: '1 needs you', count: 2 })
    expect(activityFace([failed, item({ id: 'g', state: 'partial' })])?.label).toBe('2 need you')
  })

  it('names a single waiting item, and shows progress or a task count while working', () => {
    expect(activityFace([item({ id: 'u', state: 'waiting', title: 'Restart to update' })])?.label).toBe('Restart to update')
    expect(activityFace([item({ id: 'r', progress: 0.429 })])).toEqual({ tone: 'working', label: '42%', progress: 0.429, count: 1 })
    expect(activityFace([item({ id: 'r' }), item({ id: 's', progress: 0.5 })])?.label).toBe('Working · 2 tasks')
    expect(activityFace([item({ id: 'd', state: 'done' })])?.tone).toBe('done')
    expect(activityFace([])).toBeNull()
  })
})

describe('newEndings', () => {
  it('finds what was running and has ended unseen', () => {
    const before = new Map([['a', item({ id: 'a' })], ['b', item({ id: 'b', state: 'failed' })]])
    const after = [item({ id: 'a', state: 'done' }), item({ id: 'b', state: 'failed' }), item({ id: 'c', state: 'done' })]
    expect(newEndings(before, after).map((entry) => entry.id)).toEqual(['a'])
    expect(newEndings(before, [item({ id: 'a', state: 'done', seenAt: 5 })])).toEqual([])
  })
})

describe('bytesDetail', () => {
  it('counts in MB, or GB for big files', () => {
    expect(bytesDetail(63_000_000, 150_000_000)).toBe('63 of 150 MB')
    expect(bytesDetail(500_000_000, 2_100_000_000)).toBe('0.5 of 2.1 GB')
    expect(bytesDetail(5_000_000, 0)).toBe('5 MB')
  })
})
