import { describe, expect, it } from 'vitest'
import { createJobs, mayWriteSummary, SupersededError, summaryEdited, summaryFingerprint } from './notesJobs'

describe('createJobs', () => {
  it('lets a newer job for the same session replace the one in flight', () => {
    const jobs = createJobs()
    const first = jobs.start('a')
    const other = jobs.start('b')
    const second = jobs.start('a')
    expect(first.signal.aborted).toBe(true)
    expect(first.signal.reason).toBeInstanceOf(SupersededError)
    expect(first.current()).toBe(false)
    expect(second.current()).toBe(true)
    expect(other.current()).toBe(true)
    first.finish()
    expect(jobs.running('a')).toBe(true)
    second.finish()
    expect(jobs.running('a')).toBe(false)
  })

  it('cancels with the given reason', () => {
    const jobs = createJobs()
    const job = jobs.start('a')
    expect(jobs.cancel('a', new Error('Summary stopped'))).toBe(true)
    expect(job.signal.reason).toEqual(new Error('Summary stopped'))
    expect(jobs.cancel('a')).toBe(false)
  })
})

describe('summary edits', () => {
  const generated = 'Summary\nWe ship Friday.\n\nAction items\n- [ ] Sam: Fix the installer'
  const fingerprint = summaryFingerprint(generated)

  it('sees an untouched summary as unedited, whatever the line endings', () => {
    expect(summaryEdited(generated, fingerprint)).toBe(false)
    expect(summaryEdited(`${generated.replace(/\n/g, '\r\n')}\n`, fingerprint)).toBe(false)
    expect(summaryEdited('', undefined)).toBe(false)
  })

  it('sees a checked action item, a typed summary, or one with no fingerprint as edited', () => {
    expect(summaryEdited(generated.replace('[ ]', '[x]'), fingerprint)).toBe(true)
    expect(summaryEdited('My own summary', undefined)).toBe(true)
  })

  it('lets an automatic run write only over an untouched summary', () => {
    expect(mayWriteSummary('auto', { summary: generated, fingerprint }, generated)).toBe(true)
    expect(mayWriteSummary('auto', { summary: '', fingerprint: undefined }, '')).toBe(true)
    expect(mayWriteSummary('auto', { summary: `${generated} edited`, fingerprint }, generated)).toBe(false)
  })

  it('lets a manual run replace an edited summary, unless it changed during the run', () => {
    const edited = `${generated} edited`
    expect(mayWriteSummary('manual', { summary: edited, fingerprint }, edited)).toBe(true)
    expect(mayWriteSummary('manual', { summary: `${edited} more`, fingerprint }, edited)).toBe(false)
  })
})
