/**
 * Which microphone users are meetings. Pure, so the smoke test can check it.
 *
 * A mic user's name is what the mic watcher reports: an exe name on Windows (`Zoom`, `chrome`),
 * a package name (`MSTeams`, `91750D7E.Slack`), or a bundle id on macOS (`us.zoom.xos`).
 *
 * The lists give names and a quicker answer; they aren't the whole story. An app that isn't
 * listed still counts as a call when it is on the mic and playing sound at once (see
 * meetingDetector.ts). Browsers can't be judged that way, since one process plays every tab, so
 * they need a meeting site's title.
 */

export type MeetingApp = { id: string; label: string }

type Known = MeetingApp & {
  /** Names the watcher reports for the desktop app, lowercase. */
  apps: readonly string[]
  /** Matches the tab title a browser shows while the meeting runs on the web. */
  title?: RegExp
}

/**
 * Apps that only take the microphone for a call, so mic use alone is the signal. Chat apps whose
 * mic is also used for voice messages (WhatsApp, Telegram, Signal) are left out on purpose: a
 * long voice note would look like a call. Their real calls play sound, so they're still found.
 */
const KNOWN: readonly Known[] = [
  {
    id: 'zoom',
    label: 'Zoom',
    apps: ['zoom', 'us.zoom.xos'],
    // "Zoom Meeting", "Zoom - …"; not any page whose title starts with the word "zoom".
    title: /^zoom( meeting| workplace| webinar)?(\s[-–—|]|$)|\bzoom meeting\b/i
  },
  {
    id: 'meet',
    label: 'Google Meet',
    apps: [],
    // "Meet - abc-defg-hij" while in a call or its waiting room; "Google Meet" on older builds.
    title: /^meet\s[-–—]\s|\bgoogle meet\b/i
  },
  {
    id: 'teams',
    label: 'Microsoft Teams',
    apps: [
      'msteams',
      'teams',
      'ms-teams',
      'ms-teams_modulehost',
      'com.microsoft.teams',
      'com.microsoft.teams2'
    ],
    title: /\bmicrosoft teams\b/i
  },
  {
    id: 'slack',
    label: 'Slack',
    apps: ['slack', 'com.tinyspeck.slackmacgap'],
    // Slack on the web only takes the mic for a huddle.
    title: /\bslack\b|\bhuddle\b/i
  },
  {
    id: 'discord',
    label: 'Discord',
    apps: ['discord', 'discordptb', 'discordcanary', 'com.hnc.discord'],
    title: /\bdiscord\b/i
  },
  {
    id: 'webex',
    label: 'Webex',
    apps: [
      'webex',
      'ciscocollabhost',
      'webexmta',
      'atmgr',
      'com.cisco.webexmeetingsapp',
      'cisco-systems.spark'
    ],
    title: /\bwebex\b/i
  },
  {
    id: 'goto',
    label: 'GoTo Meeting',
    apps: ['g2mcomm', 'goto', 'gotomeeting', 'com.logmein.goto'],
    title: /\bgoto ?meeting\b/i
  },
  { id: 'skype', label: 'Skype', apps: ['skype', 'skypeapp', 'com.skype.skype'] },
  { id: 'ringcentral', label: 'RingCentral', apps: ['ringcentral', 'com.ringcentral.glip'] },
  { id: 'facetime', label: 'FaceTime', apps: ['com.apple.facetime'] },
  { id: 'jitsi', label: 'Jitsi Meet', apps: ['jitsi meet', 'org.jitsi.jitsi-meet'], title: /\bjitsi meet\b/i },
  { id: 'whereby', label: 'Whereby', apps: [], title: /\bwhereby\b/i }
]

/** Browsers: their mic use is a meeting only when a meeting site's title is showing. */
const BROWSERS: readonly string[] = [
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  'arc',
  'chromium',
  'com.google.chrome',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'com.brave.browser',
  'company.thebrowser.browser',
  'com.apple.safari'
]

/**
 * Apps that take the mic and play sound at the same time without being a call: recorders,
 * streaming tools and mic processors (some run all day). They never prompt as a meeting.
 */
const NOT_CALLS: readonly string[] = [
  'obs64',
  'obs32',
  'obs',
  'com.obsproject.obs-studio',
  'streamlabs obs',
  'audacity',
  'org.audacityteam.audacity',
  'voicemeeter',
  'voicemeeterpro',
  'voicemeeter8',
  'voicemeeter8x64',
  'nvidia broadcast',
  'nvidia broadcast ui',
  'krisp',
  'ai.krisp.krispmac',
  'com.apple.garageband10',
  'com.apple.voicememos'
]

/** `91750D7E.Slack` and `Slack` both match `slack`; bundle ids match in full. */
function matches(name: string, candidates: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return candidates.some((entry) => lower === entry || lower.endsWith(`.${entry}`))
}

export type MicUserKind =
  | { kind: 'meeting'; meeting: MeetingApp }
  | { kind: 'browser' }
  /** Known not to be a call, even while it plays sound. */
  | { kind: 'not-call' }
  /** Anything else: a call if it is also playing sound. */
  | { kind: 'other' }

export function classifyMicUser(name: string): MicUserKind {
  if (!name) return { kind: 'other' }
  const known = KNOWN.find((entry) => matches(name, entry.apps))
  if (known) return { kind: 'meeting', meeting: { id: known.id, label: known.label } }
  if (matches(name, BROWSERS)) return { kind: 'browser' }
  if (matches(name, NOT_CALLS)) return { kind: 'not-call' }
  return { kind: 'other' }
}

/** The meeting a browser window title shows, if any. Titles are matched here and never logged. */
export function meetingFromTitles(titles: readonly string[]): MeetingApp | null {
  for (const title of titles) {
    const known = KNOWN.find((entry) => entry.title?.test(title.trim()))
    if (known) return { id: known.id, label: known.label }
  }
  return null
}
