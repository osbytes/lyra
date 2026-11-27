import { describe, expect, it } from 'vitest'
import { overallProvenance } from './provenance'

describe('overallProvenance', () => {
  it('keeps everything local unless a cloud engine is chosen', () => {
    expect(overallProvenance({ notesEngine: 'off', cloudProvider: 'anthropic', cloudBaseUrl: null })).toEqual({
      kind: 'local',
      label: 'Everything on this computer'
    })
    expect(overallProvenance({ notesEngine: 'local', cloudProvider: 'openai', cloudBaseUrl: null })).toEqual({
      kind: 'local',
      label: 'Everything on this computer'
    })
  })

  it('names the hosted provider summaries go to', () => {
    expect(overallProvenance({ notesEngine: 'cloud', cloudProvider: 'anthropic', cloudBaseUrl: null })).toEqual({
      kind: 'cloud',
      label: 'Summaries go to Anthropic'
    })
  })

  it('names a server by its host, and never claims it is local', () => {
    expect(
      overallProvenance({ notesEngine: 'cloud', cloudProvider: 'openai-compatible', cloudBaseUrl: 'http://user@localhost:11434/v1' })
    ).toEqual({ kind: 'cloud', label: 'Summaries go to localhost:11434' })
    expect(overallProvenance({ notesEngine: 'cloud', cloudProvider: 'openai-compatible', cloudBaseUrl: null })).toEqual({
      kind: 'cloud',
      label: 'Summaries go to a server'
    })
  })
})
