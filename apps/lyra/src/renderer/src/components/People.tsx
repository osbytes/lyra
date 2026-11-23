import { useEffect, useRef, useState } from 'react'
import type { Person } from '../../../shared/types'
import { openMicrophone, startCapture, type CaptureHandle } from '../audio/capture'
import { SAMPLE_RATE } from '../../../shared/audio/vad'
import { log } from '../lib/log'

const ENROLL_SECONDS = 20

const PASSAGE =
  'The quick brown fox jumps over the lazy dog. I’m recording a short sample so Lyra can ' +
  'recognize my voice in meetings. Today I’ll talk about plans for the week, a few open ' +
  'questions, and what I need from the team. Numbers like one, two, three, and forty-two help too.'

export function usePeople(): Person[] {
  const [people, setPeople] = useState<Person[]>([])
  useEffect(() => {
    void window.api.listPeople().then(setPeople)
    return window.api.onPeopleChanged(setPeople)
  }, [])
  return people
}

type EnrollProps = { micDeviceId: string | null; onDone: () => void }

/** Records ~20 s of read-aloud speech and saves it as a voiceprint. */
function Enroll({ micDeviceId, onDone }: EnrollProps) {
  const [name, setName] = useState('')
  const [self, setSelf] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  const capture = useRef<CaptureHandle | null>(null)

  useEffect(() => () => capture.current?.stop(), [])

  const record = async (): Promise<void> => {
    setError(null)
    const frames: Float32Array[] = []
    let samples = 0
    try {
      const { stream } = await openMicrophone(micDeviceId)
      setPhase('recording')
      await new Promise<void>((resolve, reject) => {
        void startCapture(
          stream,
          (frame) => {
            frames.push(frame)
            samples += frame.length
            setElapsed(samples / SAMPLE_RATE)
            if (samples >= ENROLL_SECONDS * SAMPLE_RATE) resolve()
          },
          (reason) => {
            reject(new Error(reason))
          }
        ).then((handle) => {
          capture.current = handle
        }, reject)
      })
      capture.current?.stop()
      capture.current = null
      setPhase('saving')
      const pcm = new Float32Array(samples)
      let offset = 0
      for (const frame of frames) {
        pcm.set(frame, offset)
        offset += frame.length
      }
      await window.api.enrollPerson(name, pcm, self)
      onDone()
    } catch (caught) {
      capture.current?.stop()
      capture.current = null
      log('people', 'enroll failed', String(caught))
      setError(caught instanceof Error ? caught.message : 'Could not save the voice')
      setPhase('idle')
    }
  }

  return (
    <div className="enroll">
      {phase === 'idle' ? (
        <>
          <div className="enroll-fields">
            <input
              className="settings-input"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
              placeholder="Name"
              aria-label="Person's name"
            />
            <label className="enroll-self">
              <input
                type="checkbox"
                checked={self}
                onChange={(event) => {
                  setSelf(event.target.checked)
                }}
              />
              This is me
            </label>
          </div>
          <p className="settings-notice">
            They’ll read a short passage aloud for {ENROLL_SECONDS} seconds. Only record people who
            agree to it — the voiceprint stays on this computer.
          </p>
          <div className="settings-buttons">
            <button
              className="btn primary"
              type="button"
              disabled={!name.trim()}
              onClick={() => void record()}
            >
              Start recording
            </button>
            <button className="btn" type="button" onClick={onDone}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="enroll-passage">{PASSAGE}</p>
          <div className="enroll-progress" aria-hidden="true">
            <span style={{ width: `${Math.min(100, (elapsed / ENROLL_SECONDS) * 100)}%` }} />
          </div>
          <p className="settings-notice">
            {phase === 'recording'
              ? `Recording… ${Math.ceil(Math.max(0, ENROLL_SECONDS - elapsed))} s left`
              : 'Saving voice (the first time downloads a ~32 MB model)…'}
          </p>
        </>
      )}
      {error ? <p className="settings-notice is-error">{error}</p> : null}
    </div>
  )
}

function PersonRow({ person }: { person: Person }) {
  const [name, setName] = useState(person.name)
  useEffect(() => {
    setName(person.name)
  }, [person.name])

  const commitName = (): void => {
    if (name.trim() && name !== person.name) void window.api.renamePerson(person.id, name)
    else setName(person.name)
  }

  return (
    <li className="person">
      <input
        className="settings-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
        }}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        aria-label={`Name for ${person.name}`}
      />
      <span className="person-meta">
        {person.samples} {person.samples === 1 ? 'sample' : 'samples'}
      </span>
      {person.self ? (
        <span className="person-self">You</span>
      ) : (
        <button className="btn ghost" type="button" onClick={() => void window.api.setSelfPerson(person.id)}>
          This is me
        </button>
      )}
      <button
        className="btn ghost danger"
        type="button"
        onClick={() => {
          if (window.confirm(`Delete ${person.name}’s voiceprint? This cannot be undone.`)) {
            void window.api.deletePerson(person.id)
          }
        }}
      >
        Delete
      </button>
    </li>
  )
}

/** Settings → People: saved voices used to name speakers in meetings. */
export function PeopleSettings({ micDeviceId }: { micDeviceId: string | null }) {
  const people = usePeople()
  const [adding, setAdding] = useState(false)

  return (
    <div className="people">
      {people.length ? (
        <ul className="people-list">
          {people.map((person) => (
            <PersonRow key={person.id} person={person} />
          ))}
        </ul>
      ) : (
        <p className="settings-notice">
          No saved voices yet. Speakers show up as “Speaker 1”, “Speaker 2”… until you name them —
          naming one in a meeting note can save their voice too.
        </p>
      )}
      {adding ? (
        <Enroll
          micDeviceId={micDeviceId}
          onDone={() => {
            setAdding(false)
          }}
        />
      ) : (
        <button
          className="btn"
          type="button"
          onClick={() => {
            setAdding(true)
          }}
        >
          Add a person
        </button>
      )}
    </div>
  )
}
