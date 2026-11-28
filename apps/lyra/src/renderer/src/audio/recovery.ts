/**
 * Pure pieces of keeping a recording alive when its devices come and go: retry timing, when a
 * device change is worth reopening system audio for, when a stall deserves a notice, and what to
 * tell the user when the microphone can't be opened. No browser APIs here, so they're unit-tested.
 */

/**
 * Waits before each reopen: quick at first (a Bluetooth headset switching to its call profile
 * comes back within a second or two), then every few seconds for about a minute.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [
  500,
  1000,
  2000,
  ...new Array<number>(12).fill(4000)
]

export type RetryOptions<T> = {
  delays: readonly number[]
  /** The capture was stopped: give up, and dispose anything opened meanwhile. */
  cancelled: () => boolean
  dispose: (value: T) => void
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Calls `open` after each delay until it returns something. Resolves with what it opened and on
 * which attempt (1-based), or null when every attempt failed or the capture stopped.
 */
export async function retryOpen<T>(
  open: () => Promise<T | null>,
  { delays, cancelled, dispose, sleep = wait }: RetryOptions<T>
): Promise<{ value: T; attempt: number } | null> {
  let attempt = 0
  for (const delay of delays) {
    attempt++
    await sleep(delay)
    if (cancelled()) return null
    const value = await open().catch(() => null)
    if (value === null) continue
    // Stop can land while `open` is in flight.
    if (cancelled()) {
      dispose(value)
      return null
    }
    return { value, attempt }
  }
  return null
}

/**
 * Whether system audio should be reopened after the devices changed. Loopback follows the
 * output that was the default when it opened, so it only needs reopening when the track died or
 * the default output moved (headphones plugged in, a call switched to a headset); plugging in an
 * unrelated USB device must not cut the call's audio. When the default can't be read, reopen, as
 * before.
 */
export function shouldReopenSystem(change: {
  trackEnded: boolean
  before: string | null
  after: string | null
}): boolean {
  if (change.trackEnded) return true
  if (change.before === null || change.after === null) return true
  return change.before !== change.after
}

/**
 * When computer audio didn't open as recording started: three more tries with backoff, since the
 * output device is often briefly busy (another app opening it, a headset's software starting up).
 */
export const SYSTEM_START_DELAYS_MS: readonly number[] = [1000, 2000, 4000]

/**
 * Computer audio during a recording: not asked for, being recorded, being opened (again), given
 * up on (a Retry away), or refused by the OS (a settings page away).
 */
export type SystemAudioState = 'off' | 'live' | 'retrying' | 'unavailable' | 'blocked'

export type SystemAudioChange = 'retrying' | 'restored' | 'unavailable' | 'blocked'

/** Follows what the capture reports about computer audio. A refusal by the OS outlasts the retries. */
export function nextSystemAudio(state: SystemAudioState, change: SystemAudioChange): SystemAudioState {
  if (state === 'off') return 'off'
  switch (change) {
    case 'restored':
      return 'live'
    case 'blocked':
      return state === 'live' ? 'live' : 'blocked'
    case 'retrying':
    case 'unavailable':
      return state === 'blocked' ? 'blocked' : change
  }
}

/** How many stalled heartbeats in a row before the user is told nothing is being captured. */
export const STALLS_BEFORE_NOTICE = 2

export type StallState = { stalls: number; warned: boolean }

/**
 * Follows heartbeats: says when to try recovering the audio path, and when to show or clear the
 * notice that nothing is being captured.
 */
export function nextStall(
  state: StallState,
  stalled: boolean
): { state: StallState; recover: boolean; notice: 'show' | 'clear' | null } {
  if (!stalled) {
    return { state: { stalls: 0, warned: false }, recover: false, notice: state.warned ? 'clear' : null }
  }
  const stalls = state.stalls + 1
  const warn = !state.warned && stalls >= STALLS_BEFORE_NOTICE
  return {
    state: { stalls, warned: state.warned || warn },
    recover: true,
    notice: warn ? 'show' : null
  }
}

/** Where the OS keeps microphone permission, for the platform Lyra is running on. */
function privacySettings(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'System Settings → Privacy & Security → Microphone, and turn on Lyra'
    case 'win32':
      return 'Settings → Privacy & security → Microphone, and turn on microphone access for desktop apps'
    default:
      return 'your system’s privacy or sound settings, and allow Lyra to use the microphone'
  }
}

function soundSettings(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'System Settings → Sound → Input'
    case 'win32':
      return 'Settings → System → Sound → Input'
    default:
      return 'your system’s sound settings'
  }
}

/**
 * What to tell the user when `getUserMedia` fails, by the DOMException's name; null for errors
 * that have nothing more useful to say than their own message.
 */
export function microphoneErrorMessage(name: string, platform: string): string | null {
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Lyra isn’t allowed to use the microphone. Open ${privacySettings(platform)}.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No microphone found. Connect one, or check ${soundSettings(platform)}.`
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone couldn’t be opened. Another app may be using it, or it was just unplugged.'
    default:
      return null
  }
}

/** The microphone opened but its track was already dead (usually the OS blocking it). */
export function microphoneDidNotStart(platform: string): string {
  return `The microphone did not start. Check ${privacySettings(platform)}.`
}
