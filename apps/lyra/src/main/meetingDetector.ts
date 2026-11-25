import { classifyMicUser, meetingFromTitles } from './meetingApps'
import type { MicUsers } from './micwatch'

/** What to ask about. `key` names it for "Not now" and "Don't ask"; `user` is the mic user. */
export type PromptTarget = { kind: 'meeting' | 'mic'; key: string; label: string; user: string }

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
  /** How long an app must hold the mic before we ask; a quick mic test or voice clip doesn't. */
  sustainMs: number
  /** After "Not now", how long that meeting app stays quiet. */
  snoozeMs: number
  /** Title reads per browser mic use; a browser on the mic for dictation shouldn't spawn forever. */
  maxTitleChecks: number
}

export const DETECTOR_DEFAULTS = {
  sustainMs: 2000,
  snoozeMs: 30 * 60_000,
  maxTitleChecks: 5
} as const

/**
 * Decides when a change in who uses the microphone is worth a prompt. Mic users present when the
 * watcher starts are skipped until they let go, so turning Lyra on mid-call stays quiet.
 */
export class MeetingDetector {
  private firstSeen = new Map<string, number>()
  /** Mic users already asked about (or skipped) during their current use. */
  private settled = new Set<string>()
  private titleChecks = new Map<string, number>()
  private snoozed = new Map<string, number>()
  private started = false

  constructor(private readonly options: DetectorOptions) {}

  reset(): void {
    this.firstSeen.clear()
    this.settled.clear()
    this.titleChecks.clear()
    this.started = false
  }

  snooze(key: string): void {
    this.snoozed.set(key, this.options.now() + this.options.snoozeMs)
  }

  /**
   * When to look again without a change in mic users (the helpers report changes only): once a
   * new user has held the mic long enough, or soon after, for a browser whose tab may come to front.
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

  async update(users: MicUsers, policy: DetectorPolicy): Promise<PromptTarget | null> {
    const now = this.options.now()
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
      const target = await this.judge(user, policy)
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

  /** A target, null for "never for this use", or 'wait' to look again on the next update. */
  private async judge(user: string, policy: DetectorPolicy): Promise<PromptTarget | null | 'wait'> {
    const mic: PromptTarget = { kind: 'mic', key: user, label: user, user }
    const found = classifyMicUser(user)
    switch (found.kind) {
      case 'meeting':
        return { kind: 'meeting', key: found.meeting.id, label: found.meeting.label, user }
      case 'browser': {
        if (!policy.meetings) return policy.anyApp ? mic : null
        const checks = (this.titleChecks.get(user) ?? 0) + 1
        this.titleChecks.set(user, checks)
        const meeting = meetingFromTitles(await this.options.titles(user))
        if (meeting) return { kind: 'meeting', key: meeting.id, label: meeting.label, user }
        // The meeting tab may not be in front yet; give it a few polls before settling.
        if (checks < this.options.maxTitleChecks) return 'wait'
        return policy.anyApp ? mic : null
      }
      case 'other':
        return policy.anyApp ? mic : null
    }
  }
}
