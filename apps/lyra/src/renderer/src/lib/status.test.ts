import { describe, expect, it } from 'vitest'
import type { MeetingStatus } from '../../../shared/types'
import {
  behindLabel,
  phaseAnnouncement,
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
