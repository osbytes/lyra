import { useEffect, useRef, useState } from 'react'
import type { Person } from '../../../shared/types'
import { openMicrophone, startCapture, type CaptureHandle } from '../audio/capture'
import { SAMPLE_RATE } from '../../../shared/audio/vad'
import { perform } from '../lib/history'
import { log } from '../lib/log'
import { ConfirmDialog } from './ConfirmDialog'
import { useContextMenu } from './ContextMenu'
import { TrashIcon } from './Icons'

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
            agree to it. The voiceprint stays on this computer.
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
              : 'Saving voice (the first time downloads a ~46 MB model)…'}
          </p>
        </>
      )}
      {error ? <p className="settings-notice is-error">{error}</p> : null}
    </div>
  )
}

/** Who "me" is now, so making someone else "me" can be undone. */
function selfId(people: readonly Person[]): string | null {
  return people.find((person) => person.self)?.id ?? null
}

function PersonRow({ person, people }: { person: Person; people: readonly Person[] }) {
  const [name, setName] = useState(person.name)
  const [confirming, setConfirming] = useState(false)
  const menu = useContextMenu()
  useEffect(() => {
    setName(person.name)
  }, [person.name])

  const commitName = (): void => {
    const next = name.trim()
    if (!next || next === person.name) {
      setName(person.name)
      return
    }
    const before = person.name
    void perform({
      label: `Renamed ${before} to ${next}`,
      run: () => window.api.renamePerson(person.id, next),
      undo: () => window.api.renamePerson(person.id, before)
    })
  }

  const makeSelf = (): void => {
    const before = selfId(people)
    void perform({
      label: `Marked ${person.name} as you`,
      run: () => window.api.setSelfPerson(person.id),
      undo: () => window.api.setSelfPerson(before)
    })
  }

  const remove = (): void => {
    setConfirming(false)
    void perform({
      label: `Deleted ${person.name}’s voice`,
      undoneLabel: `Restored ${person.name}’s voice`,
      run: () => window.api.deletePerson(person.id),
      undo: () => window.api.restorePerson(person.id)
    })
  }

  return (
    <li
      className="person"
      onContextMenu={(event) => {
        menu.open(event, person.name, [
          ...(person.self ? [] : [{ label: 'This is me', run: makeSelf }]),
          { label: 'Delete voice…', icon: <TrashIcon />, danger: true, run: () => setConfirming(true) }
        ])
      }}
    >
      <input
        className="settings-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
        }}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          else if (event.key === 'Escape' && name !== person.name) {
            event.preventDefault()
            event.stopPropagation()
            setName(person.name)
          }
        }}
        aria-label={`Name for ${person.name}`}
      />
      <span className="person-meta">
        {person.samples} {person.samples === 1 ? 'sample' : 'samples'}
      </span>
      {person.self ? (
        <span className="person-self">You</span>
      ) : (
        <button className="btn ghost" type="button" onClick={makeSelf}>
          This is me
        </button>
      )}
      <button className="btn ghost danger" type="button" onClick={() => setConfirming(true)}>
        Delete
      </button>
      {confirming ? (
        <ConfirmDialog
          title={`Delete ${person.name}’s voice?`}
          confirm="Delete voice"
          danger
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        >
          Lyra will stop recognizing them in new sessions. Sessions already named keep the name.
        </ConfirmDialog>
      ) : null}
      {menu.element}
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
            <PersonRow key={person.id} person={person} people={people} />
          ))}
        </ul>
      ) : (
        <p className="settings-notice">
          No saved voices yet. Speakers show up as “Speaker 1”, “Speaker 2”… until you name them, and
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
