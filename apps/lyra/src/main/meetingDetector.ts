import { classifyMicUser, meetingFromTitles } from './meetingApps'
import type { AudioUsers } from './micHelperLine'

/**
 * What to ask about. `key` names it for "Dismiss"; `label` is shown and is what "Don't ask"
 * stores; `user` is the mic user. `via` is the signal that decided it, for the log: a listed app,
 * a browser's meeting title, mic and playback together (an unlisted call app), or plain mic use.
 */
export type PromptTarget = {
  kind: 'meeting' | 'mic'
  key: string
  label: string
  user: string
  via: 'app' | 'title' | 'audio' | 'mic'
}

export type DetectorPolicy = {
  /** Offer to record when a meeting app (or a browser on a meeting site) takes the mic. */
  meetings: boolean
  /** Offer for any app that takes the mic. */
  anyApp: boolean
  recording: boolean
  ignored: (label: string) => boolean
}

export type DetectorOptions = {
  now: () => number
  titles: (user: string) => Promise<string[]>
  /** How long an app must hold the mic (and play sound, to count as a call) before we ask. */
  sustainMs: number
  /** After "Dismiss", how long that meeting app stays quiet. */
  snoozeMs: number
  /** Title reads per browser mic use; a browser on the mic for dictation shouldn't spawn forever. */
  maxTitleChecks: number
  /** How long an unlisted app on the mic may take to start playing sound and count as a call. */
  callWaitMs: number
}

export const DETECTOR_DEFAULTS = {
  sustainMs: 2000,
  snoozeMs: 30 * 60_000,
  maxTitleChecks: 5,
  callWaitMs: 30_000
} as const

/**
 * Decides when a change in who uses the microphone is worth a prompt. Mic users present when the
 * watcher starts are skipped until they let go, so turning Lyra on mid-call stays quiet.
 *
 * A meeting is a listed call app on the mic, a browser on the mic showing a meeting site, or any
 * other app that is on the mic and playing sound at once: what a call looks like from outside,
 * so call apps nobody listed are found too.
 */
export class MeetingDetector {
  private firstSeen = new Map<string, number>()
  /** When each app started playing sound, while it still is. */
  private playingSince = new Map<string, number>()
  /** Mic users already asked about (or skipped) during their current use. */
  private settled = new Set<string>()
  private titleChecks = new Map<string, number>()
  private snoozed = new Map<string, number>()
  private started = false

  constructor(private readonly options: DetectorOptions) {}

  reset(): void {
    this.firstSeen.clear()
    this.playingSince.clear()
    this.settled.clear()
    this.titleChecks.clear()
    this.started = false
  }

  snooze(key: string): void {
    this.snoozed.set(key, this.options.now() + this.options.snoozeMs)
  }

  /**
   * When to look again without a change in mic users (the helpers report changes only): once a
   * new user has held the mic long enough, or soon after, for an app still waiting on a signal.
   */
  nextCheckAt(): number | null {
    const now = this.options.now()
    let next: number | null = null
    for (const [user, since] of this.firstSeen) {
      if (this.settled.has(user)) continue
      const due = Math.max(since + this.options.sustainMs, now + this.options.sustainMs / 2)
      next = next === null ? due : Math.min(next, due)
    }
    return next
  }

  async update(audio: AudioUsers, policy: DetectorPolicy): Promise<PromptTarget | null> {
    const now = this.options.now()
    const users = audio.mic
    for (const app of [...this.playingSince.keys()]) {
      if (!audio.playing.has(app)) this.playingSince.delete(app)
    }
    for (const app of audio.playing) if (!this.playingSince.has(app)) this.playingSince.set(app, now)
    for (const user of [...this.firstSeen.keys()]) {
      if (users.has(user)) continue
      this.firstSeen.delete(user)
      this.settled.delete(user)
      this.titleChecks.delete(user)
    }
    for (const user of users) if (!this.firstSeen.has(user)) this.firstSeen.set(user, now)
    if (!this.started) {
      this.started = true
      for (const user of users) this.settled.add(user)
      return null
    }
    // A call that was already on while Lyra recorded isn't news once the recording stops.
    if (policy.recording) for (const user of users) this.settled.add(user)
    if (policy.recording || (!policy.meetings && !policy.anyApp)) return null

    for (const user of users) {
      if (this.settled.has(user)) continue
      if (now - (this.firstSeen.get(user) ?? now) < this.options.sustainMs) continue
      const target = await this.judge(user, policy, now)
      if (target === 'wait') continue
      this.settled.add(user)
      if (!target || policy.ignored(target.label) || this.isSnoozed(target.key, now)) continue
      return target
    }
    return null
  }

  private isSnoozed(key: string, now: number): boolean {
    const until = this.snoozed.get(key)
    if (until === undefined) return false
    if (until > now) return true
    this.snoozed.delete(key)
    return false
  }

  /** On the mic and playing sound, both for a while. */
  private callShaped(user: string, now: number): boolean {
    const since = this.playingSince.get(user)
    return since !== undefined && now - since >= this.options.sustainMs
  }

  /** A target, null for "never for this use", or 'wait' to look again on the next update. */
  private async judge(
    user: string,
    policy: DetectorPolicy,
    now: number
  ): Promise<PromptTarget | null | 'wait'> {
    const mic: PromptTarget = { kind: 'mic', key: user, label: user, user, via: 'mic' }
    const found = classifyMicUser(user)
    switch (found.kind) {
      case 'meeting': {
        const { id, label } = found.meeting
        return { kind: 'meeting', key: id, label, user, via: 'app' }
      }
      case 'browser': {
        // One browser process plays every tab, so its playback says nothing; its title does.
        if (!policy.meetings) return policy.anyApp ? mic : null
        const checks = (this.titleChecks.get(user) ?? 0) + 1
        this.titleChecks.set(user, checks)
        const meeting = meetingFromTitles(await this.options.titles(user))
        if (meeting) {
          return { kind: 'meeting', key: meeting.id, label: meeting.label, user, via: 'title' }
        }
        // The meeting tab may not be in front yet; give it a few polls before settling.
        if (checks < this.options.maxTitleChecks) return 'wait'
        return policy.anyApp ? mic : null
      }
      case 'not-call':
        return policy.anyApp ? mic : null
      case 'other': {
        if (policy.meetings && this.callShaped(user, now)) {
          return { kind: 'meeting', key: user.toLowerCase(), label: user, user, via: 'audio' }
        }
        if (policy.anyApp) return mic
        // A call app may sit on the mic in a lobby, or while it connects, before any sound plays.
        const since = this.firstSeen.get(user) ?? now
        return policy.meetings && now - since < this.options.callWaitMs ? 'wait' : null
      }
    }
  }
}
