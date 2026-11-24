import { DAY, hoursAgo, minutesAgo, stem } from './time'
import type { DemoState, Line, Session, Speaker } from './types'

/** The demo call's length; the meeting card plays all of it. */
export const CALL_SECONDS = 15

const SPEAKERS: Speaker[] = [
  { id: 'c1', name: 'You', anon: 'You', confirmed: true, confidence: null, personId: null, track: 'mic', matchAt: null },
  { id: 'c2', name: 'Priya', anon: 'Speaker 2', confirmed: false, confidence: 0.71, personId: 'p-7f3a', track: 'system', matchAt: 4.4 },
  { id: 'c3', name: 'Speaker 3', anon: 'Speaker 3', confirmed: false, confidence: null, personId: null, track: 'system', matchAt: null }
]

const LINES: Omit<Line, 'original'>[] = [
  { id: 's001', cluster: 'c1', start: 0.4, end: 3.1, confidence: 0.97, text: 'Quick one today. Where are we on the Windows build?' },
  { id: 's002', cluster: 'c2', start: 3.4, end: 7.0, confidence: 0.74, text: 'The installer works. Signing is still waiting on the certificate, which should land Wednesday.' },
  { id: 's003', cluster: 'c3', start: 7.3, end: 9.7, confidence: null, text: 'I can test it on the old Surface once it’s signed.' },
  { id: 's004', cluster: 'c1', start: 10.0, end: 12.3, confidence: 0.95, text: 'Great. Then we ship Thursday if nothing breaks.' },
  { id: 's005', cluster: 'c2', start: 12.6, end: 14.7, confidence: 0.55, text: 'I’ll write the release notes tonight.' }
]

type SessionSeed = Omit<Session, 'id' | 'ext' | 'summary' | 'fromDemo'> & { ext?: Session['ext'] }

function session(seed: SessionSeed): Session {
  const ext = seed.ext ?? 'txt'
  return { ...seed, ext, id: `${stem(seed.startedAt)}.${ext}`, summary: null, fromDemo: false }
}

/** The demo's starting state, dated relative to `now` (the time the page was rendered). */
export function initialState(now: number): DemoState {
  const sessions = [
    session({
      title: 'Product ideas',
      tags: ['design'],
      meeting: false,
      startedAt: minutesAgo(now, 26),
      editedAt: minutesAgo(now, 2),
      seconds: 41,
      tracks: ['mic'],
      body: [
        'Lyra should feel like a notebook, not a chatbot.',
        'A few things worth trying next:\n- Rename pages inline from the sidebar\n- Keyboard shortcut for record / stop\n- Export a page as plain text or markdown',
        'The core loop is already good: open a page, talk, edit, copy, come back later.'
      ].join('\n\n')
    }),
    session({
      title: 'Morning journal',
      tags: [],
      meeting: false,
      startedAt: hoursAgo(now, 5),
      editedAt: hoursAgo(now, 4.9),
      seconds: 128,
      tracks: ['mic'],
      body: [
        'Woke up thinking about how much easier it is to say a thought than to type it.',
        'Walked to the bakery and talked through the week on the way back. Three pages by the time I got home, and none of it needed fixing.'
      ].join('\n\n')
    }),
    session({
      title: 'Release check-in',
      tags: ['team'],
      meeting: true,
      startedAt: hoursAgo(now - DAY, 2),
      editedAt: hoursAgo(now - DAY, 1.7),
      seconds: CALL_SECONDS,
      tracks: ['mic', 'system'],
      body: 'Ask design for the updated installer screenshots before Thursday.'
    }),
    session({
      title: 'Reading list',
      ext: 'md',
      tags: ['personal'],
      meeting: false,
      startedAt: now - 4 * DAY,
      editedAt: now - 4 * DAY + 20 * 60_000,
      seconds: 64,
      tracks: ['mic'],
      body: [
        'Finish the chapter on constraints in the design book.',
        'Ask Priya for the podcast she mentioned about speech models.'
      ].join('\n\n')
    })
  ]
  const [first] = sessions
  const meeting = sessions.find((s) => s.meeting)
  return {
    now,
    sessions,
    speakers: SPEAKERS,
    lines: LINES.map((line) => ({ ...line, original: line.text })),
    doneActions: [false, false],
    settings: { retention: '30', systemAudio: true, notesEngine: 'off', noticeSeen: false },
    currentId: first?.id ?? '',
    tagFilter: null,
    panel: false,
    transcriberAt: null,
    trashed: null,
    selectedFile: { kind: 'export', id: meeting?.id ?? first?.id ?? '' },
    notesBusy: false
  }
}
