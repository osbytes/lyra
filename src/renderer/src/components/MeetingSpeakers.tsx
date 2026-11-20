import { useCallback, useEffect, useState } from 'react'
import type { MeetingSpeaker, MeetingStatus } from '../../../shared/types'
import { usePeople } from './People'

const NEW_PERSON = '__new__'

function statusLabel(status: MeetingStatus): string {
  const pct = `${Math.round(status.progress * 100)}%`
  switch (status.state) {
    case 'downloading':
      return `Downloading speaker models… ${pct}`
    case 'diarizing':
      return 'Finding who spoke when…'
    case 'transcribing':
      return `Transcribing each speaker… ${pct}`
    case 'error':
      return `Couldn’t label speakers: ${status.message ?? 'unknown error'}`
    case 'done':
      return 'Speakers labeled'
  }
}

/** Latest processing status for `pageId`, cleared a moment after it finishes. */
export function useMeetingStatus(pageId: string | undefined): MeetingStatus | null {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    setStatus(null)
    return window.api.onMeetingStatus((next) => {
      if (next.pageId === pageId) setStatus(next)
    })
  }, [pageId])
  useEffect(() => {
    if (status?.state !== 'done') return
    const timer = setTimeout(() => {
      setStatus(null)
    }, 2500)
    return () => {
      clearTimeout(timer)
    }
  }, [status])
  return status
}

function SpeakerChip({ pageId, speaker }: { pageId: string; speaker: MeetingSpeaker }) {
  const people = usePeople()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [remember, setRemember] = useState(true)

  const assignNew = (): void => {
    if (!name.trim()) return
    void window.api.assignSpeaker(pageId, speaker.cluster, { name, remember })
    setNaming(false)
  }

  if (naming) {
    return (
      <span className="speaker-chip is-editing">
        <input
          className="settings-input"
          autoFocus
          value={name}
          placeholder="Name"
          onChange={(event) => {
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') assignNew()
            if (event.key === 'Escape') setNaming(false)
          }}
          aria-label={`Name for ${speaker.name}`}
        />
        <label title="Save this voice so it's recognized next time">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => {
              setRemember(event.target.checked)
            }}
          />
          Remember voice
        </label>
        <button className="btn" type="button" onClick={assignNew} disabled={!name.trim()}>
          Save
        </button>
      </span>
    )
  }

  return (
    <label className="speaker-chip">
      <select
        value={speaker.personId ?? ''}
        onChange={(event) => {
          const value = event.target.value
          if (value === NEW_PERSON) setNaming(true)
          else if (value) void window.api.assignSpeaker(pageId, speaker.cluster, { personId: value })
        }}
        aria-label={`Who is ${speaker.name}?`}
      >
        {speaker.personId ? null : <option value="">{speaker.name}</option>}
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
        <option value={NEW_PERSON}>New person…</option>
      </select>
    </label>
  )
}

/** "Who's who" bar on a labeled meeting note: rename a speaker everywhere in one step. */
export function MeetingSpeakers({ pageId, body }: { pageId: string; body: string }) {
  const [speakers, setSpeakers] = useState<MeetingSpeaker[] | null>(null)
  const status = useMeetingStatus(pageId)

  const load = useCallback(() => {
    void window.api.getMeetingSpeakers(pageId).then(setSpeakers)
  }, [pageId])

  // The note body changes when speakers are relabeled or processing finishes.
  useEffect(load, [load, body])

  if (!status && !speakers?.length) return null
  return (
    <div className="meeting-speakers">
      {status && status.state !== 'done' ? (
        <span className={`meeting-status${status.state === 'error' ? ' is-error' : ''}`}>
          {statusLabel(status)}
        </span>
      ) : null}
      {speakers?.length ? (
        <>
          <span className="meeting-speakers-label">Speakers</span>
          {speakers.map((speaker) => (
            <SpeakerChip key={speaker.cluster} pageId={pageId} speaker={speaker} />
          ))}
        </>
      ) : null}
    </div>
  )
}
