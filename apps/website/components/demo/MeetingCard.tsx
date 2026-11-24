'use client'

import { useEffect, useRef, useState } from 'react'
import { cx } from '@/lib/cx'
import { meetingNotes } from '@/lib/demo/export'
import { CALL_SECONDS } from '@/lib/demo/seed'
import { clock, formatWeekdayTime } from '@/lib/demo/time'
import { useDemo } from './DemoProvider'
import styles from './showcase.module.css'
import { Transcript } from './Transcript'

type Tab = 'transcript' | 'notes'
type Engine = 'local' | 'cloud'

const SPEAKER_CLASS: Record<string, string | undefined> = {
  c1: styles.s1,
  c2: styles.s2,
  c3: styles.s3
}

const TICKS = [0, 5, 10, 15]

/** The demo call: two tracks on a timeline, the labeled transcript, and the notes. */
export function MeetingCard() {
  const { state, dispatch } = useDemo()
  const [tab, setTab] = useState<Tab>('transcript')
  const [engine, setEngine] = useState<Engine>('local')
  const [playback, setPlayback] = useState<number | null>(null)
  const [listening, setListening] = useState<{ id: string; t: number } | null>(null)
  const frame = useRef(0)
  const meeting = state.sessions.find((session) => session.meeting)
  const notes = meetingNotes(state.speakers, state.doneActions)
  const head = playback ?? listening?.t ?? null

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current)
    },
    []
  )

  const halt = (): void => {
    cancelAnimationFrame(frame.current)
    setPlayback(null)
    setListening(null)
  }

  /** Plays `from`–`to` seconds in real time, calling `onTime` each frame. */
  const run = (from: number, to: number, onTime: (t: number) => void, onDone: () => void): void => {
    cancelAnimationFrame(frame.current)
    const started = performance.now()
    const tick = (): void => {
      const t = Math.min(to, from + (performance.now() - started) / 1000)
      onTime(t)
      if (t >= to) onDone()
      else frame.current = requestAnimationFrame(tick)
    }
    tick()
  }

  const play = (): void => {
    if (playback !== null) {
      halt()
      return
    }
    setListening(null)
    setTab('transcript')
    run(0, CALL_SECONDS, setPlayback, () => setPlayback(null))
  }

  const listen = (id: string): void => {
    const line = state.lines.find((l) => l.id === id)
    if (!line || listening?.id === id) {
      halt()
      return
    }
    setPlayback(null)
    run(line.start, line.end, (t) => setListening({ id, t }), () => setListening(null))
  }

  // Editing or naming during playback stops it, so the full transcript is back to edit.
  const interrupt = (): void => {
    if (playback !== null) halt()
  }

  return (
    <div className={cx(styles.card, head !== null && styles.isPlaying)}>
      <div className={styles.meetTop}>
        <button type="button" className={cx(styles.btn, styles.btnPrimary)} onClick={play}>
          {playback !== null ? 'Stop' : 'Play the call'}
        </button>
        <div className={styles.meetTitle}>
          {meeting?.title ?? 'Release check-in'}
          <span>{meeting ? formatWeekdayTime(meeting.startedAt) : ''}</span>
        </div>
        <span className={styles.meetClock}>{clock(head ?? CALL_SECONDS)}</span>
        <div className={styles.tabs} role="tablist" aria-label="Call view">
          {(['transcript', 'notes'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`call-tab-${name}`}
              aria-selected={tab === name}
              aria-controls={`call-panel-${name}`}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => {
                if (name === 'notes') halt()
                setTab(name)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                const next = name === 'transcript' ? 'notes' : 'transcript'
                setTab(next)
                document.getElementById(`call-tab-${next}`)?.focus()
              }}
            >
              {name === 'transcript' ? 'Transcript' : 'Notes'}
            </button>
          ))}
        </div>
      </div>

      <div role="tabpanel" id="call-panel-transcript" aria-labelledby="call-tab-transcript" hidden={tab !== 'transcript'}>
        <div className={styles.timeline}>
          <div className={styles.tlLabels}>
            <span>Microphone</span>
            <span>Computer audio</span>
          </div>
          <div className={styles.tlTracks}>
            {(['mic', 'system'] as const).map((track) => (
              <div key={track} className={styles.track}>
                {state.lines
                  .filter((line) => state.speakers.find((s) => s.id === line.cluster)?.track === track)
                  .map((line) => (
                    <span
                      key={line.id}
                      className={cx(styles.blk, SPEAKER_CLASS[line.cluster], playback !== null && playback < line.start && styles.future)}
                      style={{
                        left: `${String((line.start / CALL_SECONDS) * 100)}%`,
                        width: `${String(((line.end - line.start) / CALL_SECONDS) * 100)}%`
                      }}
                    />
                  ))}
              </div>
            ))}
            <div className={styles.playhead} style={{ left: `${String(((head ?? 0) / CALL_SECONDS) * 100)}%` }} />
            <div className={styles.ticks} aria-hidden="true">
              {TICKS.map((tick) => (
                <span key={tick} style={{ left: `${String((tick / CALL_SECONDS) * 100)}%` }}>
                  {clock(tick)}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className={cx('lyra-ui', 'card-transcript', styles.tx)} onFocusCapture={interrupt}>
          <Transcript
            lines={state.lines}
            speakers={state.speakers}
            playback={playback}
            playingLine={listening?.id ?? null}
            onListen={listen}
            onConfirm={(id) => dispatch({ type: 'confirmSpeaker', id })}
            onName={(id, name) => dispatch({ type: 'nameSpeaker', id, name })}
            onEditLine={(id, text) => dispatch({ type: 'editLine', id, text })}
            onRestoreLine={(id) => dispatch({ type: 'restoreLine', id })}
          />
        </div>
      </div>

      <div
        role="tabpanel"
        id="call-panel-notes"
        aria-labelledby="call-tab-notes"
        className={styles.notes}
        hidden={tab !== 'notes'}
      >
        <div className={styles.engine}>
          <div className={styles.segmented} role="group" aria-label="Who writes the notes">
            <button type="button" aria-pressed={engine === 'local'} onClick={() => setEngine('local')}>
              On this computer
            </button>
            <button type="button" aria-pressed={engine === 'cloud'} onClick={() => setEngine('cloud')}>
              Cloud model
            </button>
          </div>
          <p className={styles.engineCap}>
            {engine === 'local'
              ? 'Written by a small model on this computer with llama.cpp. Nothing leaves it.'
              : 'Sends the transcript text to the provider you pick (Anthropic, OpenAI, Google or your own server) with your own key. Audio and voiceprints stay on this computer.'}{' '}
            Meeting notes are off until you choose one in Settings.
          </p>
        </div>
        <div className={styles.notesGrid}>
          <div>
            <h3>Summary</h3>
            <p className={styles.summary}>{notes.summary}</p>
          </div>
          <div className={styles.notesCol}>
            <div>
              <h3>Decisions</h3>
              <ul>
                {notes.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Action items</h3>
              <ul className={styles.todo}>
                {notes.actionItems.map((item, index) => (
                  <li key={item.task}>
                    <input
                      type="checkbox"
                      id={`call-action-${String(index)}`}
                      checked={item.done}
                      onChange={() => dispatch({ type: 'toggleAction', index })}
                    />
                    <label htmlFor={`call-action-${String(index)}`}>
                      <strong>{item.owner}:</strong> {item.task}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Open questions</h3>
              <ul>
                <li className={styles.none}>None</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
