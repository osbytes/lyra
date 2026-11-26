import { describe, expect, it } from 'vitest'
import type { MeetingStatus } from '../../../shared/types'
import {
  behindLabel,
  DOCK_LABELS,
  dockActivity,
  dockLabel,
  phaseAnnouncement,
  processingActivity,
  timeLeftLabel,
  statusBusy,
  statusLabel,
  unusedSpeakerName,
  writingNotes
} from './status'

const status = (patch: Partial<MeetingStatus>): MeetingStatus => ({
  pageId: 'p',
  task: 'speakers',
  state: 'diarizing',
  progress: 0,
  ...patch
})

describe('statusLabel', () => {
  it('names the summary when writing it failed', () => {
    expect(statusLabel(status({ task: 'notes', state: 'error', message: 'offline' }))).toBe(
      'Couldn’t write the summary: offline'
    )
  })

  it('names the speakers when labeling failed', () => {
    expect(statusLabel(status({ task: 'speakers', state: 'error', message: 'no model' }))).toBe(
      'Couldn’t label speakers: no model'
    )
  })

  it('says what finished', () => {
    expect(statusLabel(status({ task: 'notes', state: 'done' }))).toBe('Summary written')
    expect(statusLabel(status({ task: 'speakers', state: 'done' }))).toBe('Speakers labeled')
  })

  it('says audio is still being processed while speakers are found', () => {
    expect(statusLabel(status({ state: 'diarizing' }))).toBe(
      'Still processing audio: finding who spoke when…'
    )
  })

  it('counts every state but done and error as busy', () => {
    expect(statusBusy(status({ state: 'diarizing' }))).toBe(true)
    expect(statusBusy(status({ state: 'downloading' }))).toBe(true)
    expect(statusBusy(status({ state: 'summarizing', task: 'notes' }))).toBe(true)
    expect(statusBusy(status({ state: 'done' }))).toBe(false)
    expect(statusBusy(status({ state: 'error' }))).toBe(false)
  })

  it('shows progress while downloading', () => {
    expect(statusLabel(status({ state: 'downloading', progress: 0.42 }))).toBe(
      'Downloading speaker models… 42%'
    )
  })
})

describe('writingNotes', () => {
  it('is true only while a summary is in progress', () => {
    expect(writingNotes(status({ task: 'notes', state: 'summarizing' }))).toBe(true)
    expect(writingNotes(status({ task: 'notes', state: 'downloading' }))).toBe(true)
    expect(writingNotes(status({ task: 'notes', state: 'error' }))).toBe(false)
    expect(writingNotes(status({ task: 'speakers', state: 'diarizing' }))).toBe(false)
    expect(writingNotes(null)).toBe(false)
  })
})

describe('behindLabel', () => {
  it('stays quiet while transcription keeps up', () => {
    expect(behindLabel({ queuedSeconds: 14.9, backend: 'gpu' })).toBeNull()
  })

  it('says how far behind, and when the CPU is doing the work', () => {
    expect(behindLabel({ queuedSeconds: 22.4, backend: 'gpu' })).toBe('Transcribing… 22 s behind')
    expect(behindLabel({ queuedSeconds: 30, backend: 'cpu' })).toBe(
      'Transcribing… 30 s behind (using the CPU)'
    )
  })
})

describe('unusedSpeakerName', () => {
  it('skips names already taken, ignoring case', () => {
    expect(unusedSpeakerName(['Speaker 1', 'speaker 2', 'Ada'])).toBe('Speaker 3')
  })

  it('fills the first gap rather than counting speakers', () => {
    // Three speakers, so "Speaker 4" by count; but "Speaker 4" exists and "Speaker 2" is free.
    expect(unusedSpeakerName(['Speaker 1', 'Speaker 3', 'Speaker 4'])).toBe('Speaker 2')
  })

  it('starts at 1', () => {
    expect(unusedSpeakerName([])).toBe('Speaker 1')
  })
})

describe('phaseAnnouncement', () => {
  it('announces changes only', () => {
    expect(phaseAnnouncement('listening', 'listening')).toBeNull()
    expect(phaseAnnouncement('idle', 'starting')).toBe('Starting to record')
    expect(phaseAnnouncement('starting', 'listening')).toBe('Recording')
    expect(phaseAnnouncement('listening', 'finishing')).toBe(
      'Recording stopped. Finishing the transcript'
    )
    expect(phaseAnnouncement('finishing', 'idle')).toBe('Transcript finished')
    expect(phaseAnnouncement('starting', 'idle')).toBe('Recording stopped')
  })
})

describe('dockLabel', () => {
  it('says Transcribing while speech waits, and Listening otherwise', () => {
    expect(dockLabel('listening', true)).toBe('Transcribing…')
    expect(dockLabel('listening', false)).toBe('Listening')
  })

  it('only ever shows a word the slot is sized for', () => {
    for (const phase of ['starting', 'listening', 'finishing'] as const) {
      for (const transcribing of [true, false]) {
        expect(DOCK_LABELS).toContain(dockLabel(phase, transcribing))
      }
    }
    expect(dockLabel('idle', true)).toBe('')
  })
})

describe('dockActivity', () => {
  it('shows a download with its progress', () => {
    expect(dockActivity({ state: 'downloading', received: 25, total: 100 }, null)).toEqual({
      text: 'Downloading the speech model…',
      detail: '25%',
      progress: 0.25,
      tone: 'busy'
    })
  })

  it('starts a download of unknown size at 0%', () => {
    expect(dockActivity({ state: 'downloading', received: 10, total: 0 }, null)?.detail).toBe('0%')
  })

  it('shows falling behind without a bar, and nothing when all is well', () => {
    expect(dockActivity({ state: 'idle' }, 'Transcribing… 20 s behind')).toEqual({
      text: 'Transcribing… 20 s behind',
      detail: null,
      progress: null,
      tone: 'busy'
    })
    expect(dockActivity({ state: 'idle' }, null)).toBeNull()
  })
})

describe('timeLeftLabel', () => {
  it('counts minutes, rounding up', () => {
    expect(timeLeftLabel(150_000, 300_000)).toBe('about 3 min left')
  })

  it('counts seconds in fives under a minute', () => {
    expect(timeLeftLabel(42_000, 300_000)).toBe('about 45 s left')
  })

  it('says almost done near and just past the estimate', () => {
    expect(timeLeftLabel(4_000, 300_000)).toBe('almost done')
    expect(timeLeftLabel(-100_000, 300_000)).toBe('almost done')
  })

  it('owns up once well past the estimate', () => {
    expect(timeLeftLabel(-160_000, 300_000)).toBe('taking longer than usual')
  })
})

describe('processingActivity', () => {
  it('times finding who spoke when against its estimate', () => {
    const diarizing = status({ estimate: { startedAt: 1_000, expectedMs: 120_000 } })
    // 30 s into a 2 min estimate: 90 s left, a quarter of the bar.
    expect(processingActivity(diarizing, 31_000)).toEqual({
      text: 'Finding who spoke when…',
      detail: 'about 2 min left',
      progress: 0.25,
      tone: 'busy'
    })
  })

  it('never fills the bar while still running', () => {
    const diarizing = status({ estimate: { startedAt: 0, expectedMs: 10_000 } })
    expect(processingActivity(diarizing, 60_000).progress).toBe(0.95)
  })

  it('spins without an estimate', () => {
    expect(processingActivity(status({}), 0)).toEqual({
      text: 'Finding who spoke when…',
      detail: null,
      progress: null,
      tone: 'busy'
    })
  })

  it('marks a failure as an error', () => {
    expect(processingActivity(status({ state: 'error', message: 'no model' }), 0).tone).toBe('error')
  })
})
