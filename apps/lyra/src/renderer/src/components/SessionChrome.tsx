import { useEffect, useState, type ReactNode } from 'react'
import type { ActivityItem } from '../../../shared/activity'
import { useMeetingStatus } from '../hooks/useMeetingStatus'
import { clockLabel } from '../lib/format'
import { log } from '../lib/log'
import type { Provenance } from '../lib/provenance'
import { processingActivity, statusBusy } from '../lib/status'
import { shortDeviceName } from '../lib/deviceName'
import { ActivityButton } from './Activity'
import { LevelMeter, type SubscribeLevel } from './Capture'
import { CloudIcon, LocalIcon, MicIcon, ProcessingIcon, SpeakerIcon } from './Icons'
import { tip } from './Tooltip'
import { Button } from './ui/button'
import { LiveDot, Spinner } from './ui/status'

/** Seconds since `since`, ticking once a second while it's set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? 0 : Math.max(0, (now - since) / 1000)
}

type ReadoutProps = {
  startedAt: number | null
  micName: string | null
  systemAudio: boolean
  /** The recorder's levels, for a meter per source. */
  subscribeLevel: SubscribeLevel
}

/**
 * While this session records: the live dot, the time, and a quiet meter per source, beside Stop
 * in the header (where the source choice sits while idle), so recording never adds a row.
 */
export function RecordingReadout({ startedAt, micName, systemAudio, subscribeLevel }: ReadoutProps) {
  const elapsed = useElapsed(startedAt)
  return (
    <span className="no-drag inline-flex items-center gap-2.5 text-[12.5px] text-text-2" role="status" aria-label="Recording">
      <LiveDot />
      <span className="font-mono text-[15px] font-medium tabular-nums text-foreground" role="timer">
        {clockLabel(elapsed)}
      </span>
      <span className="inline-flex items-center gap-1" {...tip(micName ? shortDeviceName(micName) : 'Microphone')}>
        <MicIcon className="shrink-0" />
        <LevelMeter subscribe={subscribeLevel} track="mic" />
      </span>
      {systemAudio ? (
        <span className="inline-flex items-center gap-1" {...tip('Computer audio')}>
          <SpeakerIcon className="shrink-0" />
          <LevelMeter subscribe={subscribeLevel} track="system" />
        </span>
      ) : null}
    </span>
  )
}

/**
 * Work still changing this session after recording (finding speakers, writing the summary), in
 * the status bar: fixed chrome, so nothing in the panes moves when it starts or ends.
 */
export function SessionWork({ pageId }: { pageId: string }) {
  const status = useMeetingStatus(pageId)
  if (!status || !statusBusy(status)) return null
  const activity = processingActivity(status, Date.now())
  const writing = status.task === 'notes'
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-text-2" role="status">
      {writing ? <Spinner className="size-2.5" /> : <ProcessingIcon size={13} />}
      <b className="font-medium text-foreground">{writing ? 'Writing summary' : activity.text.replace(/…$/, '')}</b>
      {activity.detail ? <span>{activity.detail}</span> : null}
      {writing ? null : <span className="truncate">labels may still change</span>}
      {writing ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[11.5px]"
          onClick={() => {
            window.api.cancelNotes(pageId).catch((error: unknown) => {
              log('notes', 'could not stop the summary', String(error))
            })
          }}
        >
          Stop
        </Button>
      ) : null}
    </span>
  )
}

type StatusBarProps = {
  provenance: Provenance
  /** The open session's work in progress (SessionWork), if any. */
  work?: ReactNode
  sessions: number
  activity: readonly ActivityItem[]
  pageTitle: (pageId: string) => string | null
  onOpen: (pageId: string) => void
}

/**
 * The status bar: where things run on the left, app-wide work on the right (the activity pill
 * opens Activity). Chrome, so nothing in the panes moves when work starts or ends.
 */
export function StatusBar({ provenance, work, sessions, activity, pageTitle, onOpen }: StatusBarProps) {
  return (
    <footer className="status-bar flex h-7 shrink-0 items-center gap-3.5 overflow-hidden border-t border-border bg-card px-3 text-[11.5px] whitespace-nowrap text-text-3">
      <span className="inline-flex items-center gap-[5px]">
        {provenance.kind === 'local' ? (
          <LocalIcon size={13} className="text-local" />
        ) : (
          <CloudIcon size={13} className="text-cloud" />
        )}
        {provenance.label}
      </span>
      {work}
      <span>
        {sessions} {sessions === 1 ? 'session' : 'sessions'}
      </span>
      <span className="ml-auto inline-flex items-center">
        <ActivityButton visible={activity} pageTitle={pageTitle} onOpen={onOpen} />
      </span>
    </footer>
  )
}
