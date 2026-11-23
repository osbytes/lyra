'use client'

// A port of apps/lyra/src/renderer/src/components/Transcript.tsx. The app's speaker picker is
// simplified: clicking a likely match confirms it, clicking any other voice names it.
import { useEffect, useRef, useState } from 'react'
import { LOW_CONFIDENCE, percent, presentSpeakers, shownSpeaker, stateOf, tier } from '@/lib/demo/speakers'
import { clock } from '@/lib/demo/time'
import type { Line, Speaker } from '@/lib/demo/types'
import { Editor } from './Editor'
import { PlayIcon, StopIcon } from './Icons'

type Props = {
  lines: Line[]
  speakers: Speaker[]
  /** Seconds into playback, during which lines appear word by word; null outside playback. */
  playback: number | null
  /** The line being listened to, if any. */
  playingLine: string | null
  onListen: (id: string) => void
  onConfirm: (id: string) => void
  onName: (id: string, name: string) => void
  onEditLine: (id: string, text: string) => void
  onRestoreLine: (id: string) => void
  /** The "Write notes" button, shown when meeting notes are turned on. */
  notes?: { busy: boolean; onWrite: () => void } | null
  /** The speaker being named, when a parent (the details panel) also starts naming. */
  naming?: string | null
  onNamingChange?: (id: string | null) => void
}

function Signal({ confidence }: { confidence: number | null }) {
  const level = tier(confidence)
  const label = confidence === null ? 'voice match unknown' : `${percent(confidence)} voice match`
  return (
    <span className={`signal l${String(level)}`} role="img" aria-label={label} title={label}>
      <i />
      <i />
      <i />
    </span>
  )
}

export function Transcript({
  lines,
  speakers,
  playback,
  playingLine,
  onListen,
  onConfirm,
  onName,
  onEditLine,
  onRestoreLine,
  notes,
  ...controlled
}: Props) {
  const [ownNaming, setOwnNaming] = useState<string | null>(null)
  const naming = controlled.naming === undefined ? ownNaming : controlled.naming
  const setNaming = controlled.onNamingChange ?? setOwnNaming
  const [picked, setPicked] = useState<string | null>(null)
  const root = useRef<HTMLElement>(null)
  const t = playback ?? Number.POSITIVE_INFINITY
  const present = presentSpeakers(speakers, lines)
  const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]))
  const pending = present.filter((speaker) => shownSpeaker(speaker, t).state !== 'sure')
  const unsure = lines.filter((line) => line.confidence !== null && line.confidence < LOW_CONFIDENCE)
  const matching = playback !== null && present.some((s) => s.matchAt !== null && t < s.matchAt && !s.confirmed)

  useEffect(() => {
    if (!picked) return
    const timer = setTimeout(() => setPicked(null), 1800)
    return () => {
      clearTimeout(timer)
    }
  }, [picked])

  const choose = (speaker: Speaker): void => {
    if (speaker.id === 'c1') return
    if (stateOf(speaker) === 'likely') onConfirm(speaker.id)
    else setNaming(speaker.id)
  }
  const finishNaming = (value: string | null): void => {
    if (naming && value?.trim()) onName(naming, value)
    setNaming(null)
  }
  const showUnsure = (): void => {
    const [first] = unsure
    if (!first) return
    setPicked(first.id)
    root.current?.querySelector(`[data-line="${first.id}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <section className="transcript" aria-label="Transcript" ref={root}>
      <div className="speakers-bar">
        <span className="speakers-label">Speakers</span>
        {present.map((speaker) => {
          const shown = shownSpeaker(speaker, t)
          if (naming === speaker.id) {
            return (
              <input
                key={speaker.id}
                className="name-input"
                autoFocus
                maxLength={24}
                placeholder="Their name"
                aria-label={`Name for ${shown.name}`}
                defaultValue={shown.state === 'unknown' ? '' : shown.name}
                onBlur={(event) => {
                  finishNaming(event.currentTarget.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishNaming(event.currentTarget.value)
                  if (event.key === 'Escape') finishNaming(null)
                }}
              />
            )
          }
          return (
            <button
              key={speaker.id}
              type="button"
              className={`speaker-chip ${shown.state}`}
              data-cluster={speaker.id}
              title={
                shown.state === 'likely' && speaker.confidence !== null
                  ? `${percent(speaker.confidence)} voice match — click to confirm`
                  : shown.state === 'unknown'
                    ? 'No saved voice matched — click to name'
                    : shown.name
              }
              onClick={() => {
                choose(speaker)
              }}
            >
              <span className="speaker-avatar" aria-hidden="true">
                {shown.avatar}
              </span>
              {shown.name}
              {shown.state === 'likely' ? <span className="speaker-q">?</span> : null}
            </button>
          )
        })}
        <span className="speakers-tools">
          {matching ? <span className="meeting-status">Matching saved voices…</span> : null}
          {notes?.busy ? <span className="meeting-status">Writing notes…</span> : null}
          {pending.length ? (
            <button
              type="button"
              className="pill"
              onClick={() => {
                const [first] = pending
                if (first) choose(first)
              }}
            >
              {pending.length} to confirm
            </button>
          ) : null}
          {unsure.length ? (
            <button type="button" className="pill" title="Lines whose voice doesn’t match their speaker well" onClick={showUnsure}>
              {unsure.length} unsure {unsure.length === 1 ? 'line' : 'lines'}
            </button>
          ) : null}
          {notes ? (
            <button type="button" className="btn ghost" disabled={notes.busy} onClick={notes.onWrite}>
              Rewrite notes
            </button>
          ) : null}
        </span>
      </div>

      <div className="lines">
        {lines.map((line, index) => {
          const speaker = byId.get(line.cluster)
          const shown = shownSpeaker(speaker, t)
          const continues = index > 0 && lines[index - 1]?.cluster === line.cluster
          const level = tier(line.confidence)
          const playing = playingLine === line.id
          const words = line.text.split(' ')
          const heard =
            t >= line.end ? words.length : Math.ceil(((t - line.start) / (line.end - line.start)) * words.length)
          return (
            <div
              key={line.id}
              data-line={line.id}
              className={[
                'line',
                continues ? 'continues' : '',
                level === 1 ? 'low' : '',
                picked === line.id ? 'picked' : '',
                playing ? 'playing' : '',
                playback !== null && t < line.start ? 'is-pending' : ''
              ].join(' ')}
            >
              <div className="gutter">
                <button
                  type="button"
                  className={`who ${shown.state}`}
                  data-cluster={line.cluster}
                  title="Change who said this"
                  onClick={() => {
                    if (speaker) choose(speaker)
                  }}
                >
                  {shown.name}
                  {shown.state === 'likely' ? '?' : ''}
                </button>
                <span className="line-meta">
                  <button
                    type="button"
                    className="line-play"
                    aria-pressed={playing}
                    aria-label={playing ? 'Stop playback' : `Listen from ${clock(line.start)}`}
                    title={playing ? 'Stop' : 'Listen'}
                    onClick={() => {
                      onListen(line.id)
                    }}
                  >
                    {playing ? <StopIcon /> : <PlayIcon />}
                    {clock(line.start)}
                  </button>
                  <Signal confidence={line.confidence} />
                  {level < 3 && line.confidence !== null ? (
                    <span className={level === 1 ? 'line-pct low' : 'line-pct'}>{percent(line.confidence)}</span>
                  ) : null}
                </span>
              </div>
              <div className="line-body">
                {playback === null ? (
                  <Editor
                    value={line.text}
                    ghost=""
                    listening={false}
                    singleLine
                    label={`Line at ${clock(line.start)}, ${shown.name}`}
                    onChange={(text) => {
                      onEditLine(line.id, text)
                    }}
                  />
                ) : (
                  <p className="line-reveal">
                    {words.map((word, i) => (
                      <span key={`${String(i)}-${word}`} className={i >= heard ? 'dim' : undefined}>
                        {i ? ' ' : ''}
                        {word}
                      </span>
                    ))}
                  </p>
                )}
                {playback === null && line.text !== line.original ? (
                  <button
                    type="button"
                    className="edited-mark"
                    title={`Original: ${line.original}`}
                    onClick={() => {
                      onRestoreLine(line.id)
                    }}
                  >
                    Edited · show original
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
