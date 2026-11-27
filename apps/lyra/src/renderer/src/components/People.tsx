import { useEffect, useRef, useState } from 'react'
import type { Person } from '../../../shared/types'
import { openMicrophone, startCapture, type CaptureHandle } from '../audio/capture'
import { SAMPLE_RATE } from '../../../shared/audio/vad'
import { perform } from '../lib/history'
import { log } from '../lib/log'
import { notify } from '../lib/toast'
import { ConfirmDialog } from './ConfirmDialog'
import { useContextMenu } from './ContextMenu'
import { TrashIcon } from './Icons'
import { tip } from './Tooltip'
import { speakerSlot } from '../lib/speakerTone'
import { SpeakerBadge } from './SpeakerBadge'
import { Button } from './ui/button'

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

/** Seconds left at which the countdown is read out; every tick would drown the passage. */
const ANNOUNCE_AT = [10, 5]

/** One press of "Start recording": what to release however it ends. */
type Attempt = {
  /** The user pressed Cancel (or Escape): drop the sample, and take back a voice saved anyway. */
  cancelled: boolean
  /** The dialog closed under it. */
  unmounted: boolean
  stream: MediaStream | null
  capture: CaptureHandle | null
  /** Ends the recording wait early. */
  abort: (() => void) | null
}

class Cancelled extends Error {}

function release(attempt: Attempt): void {
  // `stop` stops the stream's tracks too; the stream alone covers a capture that never started.
  attempt.capture?.stop()
  attempt.capture = null
  attempt.stream?.getTracks().forEach((track) => {
    track.stop()
  })
  attempt.stream = null
}

const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught))

/** Records ~20 s of read-aloud speech and saves it as a voiceprint. */
function Enroll({ micDeviceId, onDone }: EnrollProps) {
  const [name, setName] = useState('')
  const [self, setSelf] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'recording' | 'saving'>('idle')
  const [error, setError] = useState<string | null>(null)
  /** What screen readers hear: the start, a few marks, saving. Not the per-frame countdown. */
  const [announcement, setAnnouncement] = useState('')
  const attempt = useRef<Attempt | null>(null)

  // Closing Settings (or switching tabs) mid-recording: release the microphone, even if it is
  // still opening, and say the sample was dropped rather than losing it silently.
  useEffect(
    () => () => {
      const current = attempt.current
      if (!current) return
      current.unmounted = true
      const recording = current.stream !== null || current.capture !== null
      release(current)
      current.abort?.()
      if (recording) notify('Voice recording stopped before it finished; nothing was saved.')
    },
    []
  )

  const cancel = (): void => {
    const current = attempt.current
    if (!current) {
      onDone()
      return
    }
    current.cancelled = true
    release(current)
    current.abort?.()
    attempt.current = null
    setPhase('idle')
    setElapsed(0)
    setAnnouncement('Recording cancelled.')
  }

  // While recording or saving, Escape cancels the enrollment instead of closing Settings.
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    if (phase === 'idle') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [phase])

  const record = async (): Promise<void> => {
    const run: Attempt = { cancelled: false, unmounted: false, stream: null, capture: null, abort: null }
    attempt.current = run
    const stopped = (): boolean => run.cancelled || run.unmounted
    setError(null)
    setElapsed(0)
    const frames: Float32Array[] = []
    let samples = 0
    const announced = new Set<number>()
    try {
      const { stream } = await openMicrophone(micDeviceId)
      run.stream = stream
      if (stopped()) throw new Cancelled()
      setPhase('recording')
      setAnnouncement(`Recording. Read the passage aloud for ${String(ENROLL_SECONDS)} seconds.`)
      await new Promise<void>((resolve, reject) => {
        run.abort = () => {
          reject(new Cancelled())
        }
        startCapture(
          stream,
          (frame) => {
            frames.push(frame)
            samples += frame.length
            const seconds = samples / SAMPLE_RATE
            setElapsed(seconds)
            const left = Math.ceil(ENROLL_SECONDS - seconds)
            if (ANNOUNCE_AT.includes(left) && !announced.has(left)) {
              announced.add(left)
              setAnnouncement(`${String(left)} seconds left.`)
            }
            if (samples >= ENROLL_SECONDS * SAMPLE_RATE) resolve()
          },
          (reason) => {
            reject(new Error(reason))
          }
        ).then((handle) => {
          // Cancelled while the audio engine was starting: stop it at once.
          if (stopped()) handle.stop()
          else run.capture = handle
        }, reject)
      })
      release(run)
      run.abort = null
      setPhase('saving')
      setAnnouncement('Recording done. Saving the voice.')
      const pcm = new Float32Array(samples)
      let offset = 0
      for (const frame of frames) {
        pcm.set(frame, offset)
        offset += frame.length
      }
      const person = await window.api.enrollPerson(name.trim(), pcm, self)
      if (run.cancelled) {
        // Cancelled while main was saving: take it back, so Cancel means nothing was kept.
        await window.api.deletePerson(person.id).catch((caught: unknown) => {
          log('people', 'could not remove a cancelled voice', errorText(caught))
        })
        return
      }
      attempt.current = null
      notify(`Saved ${person.name}’s voice`)
      onDone()
    } catch (caught) {
      release(run)
      if (attempt.current === run) attempt.current = null
      if (stopped()) return
      log('people', 'enroll failed', errorText(caught))
      setError(caught instanceof Error ? caught.message : 'Could not save the voice')
      setAnnouncement('')
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
            <Button
              variant="primary"
              type="button"
              disabled={!name.trim()}
              onClick={() => void record()}
            >
              Start recording
            </Button>
            <Button type="button" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="enroll-passage">{PASSAGE}</p>
          <div className="enroll-progress" aria-hidden="true">
            <span style={{ width: `${String(Math.min(100, (elapsed / ENROLL_SECONDS) * 100))}%` }} />
          </div>
          <p className="settings-notice" aria-hidden="true">
            {phase === 'recording'
              ? `Recording… ${String(Math.ceil(Math.max(0, ENROLL_SECONDS - elapsed)))} s left`
              : 'Saving voice (the first time downloads a ~46 MB model)…'}
          </p>
          <div className="settings-buttons">
            <Button type="button" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
      <p className="enroll-announce" aria-live="polite">
        {announcement}
      </p>
      {error ? (
        <p className="settings-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** A voice change main refused: logged without the name, and told to the user. */
function failed(action: string, caught: unknown, message: string): void {
  log('people', `could not ${action}`, errorText(caught))
  notify(message)
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
    perform({
      label: `Renamed ${before} to ${next}`,
      run: () => window.api.renamePerson(person.id, next),
      undo: () => window.api.renamePerson(person.id, before)
    }).catch((caught: unknown) => {
      setName(person.name)
      failed('rename', caught, `Couldn’t rename ${before}.`)
    })
  }

  const makeSelf = (): void => {
    const before = selfId(people)
    perform({
      label: `Marked ${person.name} as you`,
      run: () => window.api.setSelfPerson(person.id),
      undo: () => window.api.setSelfPerson(before)
    }).catch((caught: unknown) => {
      failed('set self', caught, `Couldn’t mark ${person.name} as you.`)
    })
  }

  const remove = (): void => {
    setConfirming(false)
    perform({
      label: `Deleted ${person.name}’s voice`,
      undoneLabel: `Restored ${person.name}’s voice`,
      run: () => window.api.deletePerson(person.id),
      undo: () => window.api.restorePerson(person.id)
    }).catch((caught: unknown) => {
      failed('delete', caught, `Couldn’t delete ${person.name}’s voice.`)
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
      <SpeakerBadge name={name.trim() || '?'} slot={speakerSlot(people, person.id)} />
      {/* Reads as the name until hovered or focused: renaming is occasional, reading is constant. */}
      <input
        className="person-name"
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
        <Button variant="ghost" className="person-make-self" type="button" onClick={makeSelf}>
          Set as me
        </Button>
      )}
      <Button
        variant="ghost" size="icon" className="person-delete"
        type="button"
        aria-label={`Delete ${person.name}’s voice`}
        {...tip('Delete voice')}
        onClick={() => setConfirming(true)}
      >
        <TrashIcon />
      </Button>
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
        <Button
         
          type="button"
          onClick={() => {
            setAdding(true)
          }}
        >
          Add a person
        </Button>
      )}
    </div>
  )
}
