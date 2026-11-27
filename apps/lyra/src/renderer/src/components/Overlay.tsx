import { useCallback, useEffect, useState } from 'react'
import type { HotkeyStatus, MicPrompt, SessionState } from '../../../shared/types'
import { displayAccelerator } from './HotkeyInput'
import { CheckIcon, GripIcon, LyraIcon, RecordIcon, StopIcon } from './Icons'
import { RecordingReadout, useLevelHalo, type SubscribeLevel } from './Recording'
import { Button } from './ui/button'
import { Spinner } from './ui/status'

/** The session shortcut as the platform writes it, or null when none is registered. */
function useSessionHotkey(): string | null {
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([])
  useEffect(() => {
    const stop = window.api.onHotkeyStatus(setStatuses)
    window.api.getHotkeyStatus().then(setStatuses, () => {
      // No shortcut line then; the buttons still work.
    })
    return stop
  }, [])
  // The session shortcut is the only global one (HotkeyAction).
  const [session] = statuses
  return session?.registered ? displayAccelerator(session.accelerator) : null
}

function PromptCard({ prompt }: { prompt: MicPrompt }) {
  // The card never takes focus (it mustn't pull it from the call), so the global shortcut is the
  // keyboard's way in.
  const hotkey = useSessionHotkey()
  const who = prompt.app ? <strong>{prompt.app}</strong> : 'Another app'
  const meeting = prompt.kind === 'meeting'
  return (
    <div
      className="overlay-prompt grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-xl border-(length:--border-width) border-border bg-popover p-3 pl-3.5 text-body-sm text-popover-foreground shadow-lg"
      role="alertdialog"
      aria-label={meeting ? 'Record this meeting?' : 'Start a Lyra session?'}
    >
      <span
        className="row-span-2 grid size-8 place-items-center rounded-[8px] bg-primary text-primary-foreground"
        aria-hidden="true"
      >
        <LyraIcon />
      </span>
      {meeting ? (
        <p className="m-0">
          A call started in {who}. Record it with computer audio? Notes stay on this computer.
        </p>
      ) : (
        <p className="m-0">
          {who} is using the microphone. Start a Lyra session too?
        </p>
      )}
      {hotkey ? (
        <p className="overlay-prompt-key col-start-2 m-0 text-label text-text-3">
          Or press <kbd>{hotkey}</kbd> to start a session.
        </p>
      ) : null}
      <div className="overlay-prompt-actions col-start-2 mt-1.5 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            window.api.answerMicPrompt('start')
          }}
        >
          {meeting ? 'Record meeting' : 'Start'}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            window.api.answerMicPrompt('dismiss')
          }}
        >
          Not now
        </Button>
        {prompt.app ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              window.api.answerMicPrompt('ignore')
            }}
          >
            Never for this app
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The floating window: the recording pill, or the "mic in use" prompt. */
export function Overlay() {
  const [prompt, setPrompt] = useState<MicPrompt | null>(null)
  useEffect(() => window.api.onMicPrompt(setPrompt), [])
  return prompt ? <PromptCard prompt={prompt} /> : <RecordingPill />
}

/**
 * The floating recording pill shown while Lyra's main window is out of view: the header's
 * recording capsule on its own. A round Stop that breathes with the voice, then the time and a
 * meter per source; the rest opens Lyra. Words only when there's something to wait for.
 */
function RecordingPill() {
  // `saved`: a recording just ended and the pill is staying a moment as the way back to Lyra.
  const [{ state, saved }, setView] = useState<{ state: SessionState | null; saved: boolean }>({
    state: null,
    saved: false
  })
  const subscribeLevel = useCallback<SubscribeLevel>((listener) => window.api.onOverlayFrame(listener), [])

  useEffect(() => {
    // Subscribe first, then fetch, so a change in between isn't lost.
    const stop = window.api.onSessionState((next) => {
      setView((current) => ({
        state: next,
        saved:
          next.phase === 'idle' &&
          (current.saved || current.state?.phase === 'listening' || current.state?.phase === 'finishing')
      }))
    })
    void window.api.getSessionState().then((initial) => {
      setView((current) => (current.state ? current : { state: initial, saved: false }))
    })
    return stop
  }, [])

  const phase = state?.phase ?? 'idle'
  const listening = phase === 'listening'
  const halo = useLevelHalo<HTMLButtonElement>(subscribeLevel, listening)
  const openLyra = (): void => {
    window.api.showMainWindow()
  }

  if (saved) {
    return (
      <div className="overlay-pill">
        <span className="overlay-grip" aria-hidden="true">
          <GripIcon />
        </span>
        <button type="button" className="overlay-body overlay-saved" onClick={openLyra}>
          <CheckIcon className="shrink-0 text-success" aria-hidden="true" />
          <span className="flex-1 font-semibold">Saved</span>
          <span className="overlay-open">Open Lyra</span>
        </button>
      </div>
    )
  }

  const label = phase === 'starting' ? 'Warming up…' : phase === 'finishing' ? 'Saving…' : 'Recording'
  return (
    <div className="overlay-pill">
      <span className="overlay-grip" aria-hidden="true">
        <GripIcon />
      </span>
      {phase === 'finishing' ? (
        <span className="grid size-[28px] shrink-0 place-items-center text-text-2">
          <Spinner />
        </span>
      ) : (
        <Button
          ref={halo}
          size="icon-sm"
          variant={listening ? 'record' : 'secondary'}
          className="overlay-stop level-halo size-[28px] rounded-full transition-[background-color,border-color,color,box-shadow]"
          onClick={() => {
            window.api.requestStop()
          }}
          // A stop while warming up cancels the start (the model may still be downloading).
          aria-label={listening ? 'Stop recording' : 'Cancel starting the recording'}
        >
          {listening ? <StopIcon /> : <RecordIcon className="text-record [&_circle]:[stroke-dasharray:3_2]" />}
        </Button>
      )}
      <button type="button" className="overlay-body" onClick={openLyra} aria-label={`${label}. Open Lyra`}>
        {listening && state ? (
          <span aria-hidden="true">
            <RecordingReadout
              startedAt={state.startedAt}
              micName={state.micName}
              systemAudio={state.systemAudio}
              subscribeLevel={subscribeLevel}
            />
          </span>
        ) : (
          <span className="truncate font-semibold" aria-hidden="true">
            {label}
          </span>
        )}
      </button>
    </div>
  )
}
