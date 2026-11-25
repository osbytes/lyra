import type { SessionCommand } from '../../../shared/types'
import type { DictationPhase } from './useDictation'

/** What a tray, global-hotkey or meeting-prompt command does in the recorder's current phase. */
export type CommandAction =
  /** `queued`: the last recording is still finishing; the new one starts once it has. */
  | { do: 'start'; meeting: boolean; queued: boolean }
  /** Record into the session that is open, as the dock's button does. */
  | { do: 'continue' }
  | { do: 'stop' }
  | { do: 'ignore'; notice: string | null }

export const STILL_FINISHING_NOTICE =
  'Still finishing the last recording’s transcript. Start again once it’s done.'

/**
 * Decides a session command. While a recording is finishing, a `start` (the meeting prompt, the
 * tray) is a clear request for a new session, so it waits its turn; a `toggle` is usually a
 * second press of the hotkey that just stopped, so it's ignored with a notice rather than
 * surprising the user with a new recording later.
 *
 * `lookingAtSession`: Lyra's window has focus with a session open. A `toggle` then continues
 * that session, since that is what the user is looking at; from anywhere else (another app, the
 * tray) it starts a new one.
 */
export function sessionCommandAction(
  command: SessionCommand,
  phase: DictationPhase,
  lookingAtSession = false
): CommandAction {
  const recording = phase === 'listening' || phase === 'starting'
  switch (command.type) {
    case 'stop':
      return { do: 'stop' }
    case 'start':
      // The meeting prompt never stops a recording that started in the meantime.
      if (recording) return { do: 'ignore', notice: null }
      return { do: 'start', meeting: command.meeting, queued: phase === 'finishing' }
    case 'toggle':
      if (recording) return { do: 'stop' }
      if (phase === 'finishing') return { do: 'ignore', notice: STILL_FINISHING_NOTICE }
      if (lookingAtSession) return { do: 'continue' }
      return { do: 'start', meeting: false, queued: false }
  }
}
