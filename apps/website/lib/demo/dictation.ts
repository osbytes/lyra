// The demo's scripted voice. Like the app's streaming Whisper, the newest words stay unconfirmed
// (ghost text) and may be misheard, then firm up a few words later and are written at the
// transcriber's cursor.

export type ScriptStep =
  | { kind: 'speech'; text: string; mishear?: Readonly<Record<number, string>> }
  | { kind: 'command'; text: string }

const NEW_PARAGRAPH: ScriptStep = { kind: 'command', text: 'new paragraph' }

const SCRIPT: readonly ScriptStep[] = [
  { kind: 'speech', text: 'Okay, three things before the launch.', mishear: { 5: 'lunch.' } },
  NEW_PARAGRAPH,
  { kind: 'speech', text: 'First, the download page should say up front that nothing leaves your computer.' },
  NEW_PARAGRAPH,
  { kind: 'speech', text: 'Second, record a short demo of a call with two voices.', mishear: { 10: 'boys.' } },
  NEW_PARAGRAPH,
  { kind: 'speech', text: 'Third, ask Sam to try the Windows installer before Friday.' }
]

/** On a page that already has text, the speaker starts with "new paragraph". */
export function scriptFor(pageHasText: boolean): readonly ScriptStep[] {
  return pageHasText ? [NEW_PARAGRAPH, ...SCRIPT] : SCRIPT
}

/** How many of the newest words stay unconfirmed. */
const LOOKAHEAD = 3

export type Cursor = { step: number; revealed: number; committed: number }

export type Beat = {
  /** Confirmed words to write now (may be empty). */
  commit: string
  /** Unconfirmed words to show as ghost text after the cursor. */
  ghost: string
  /** Where the next beat starts; null when the script is over. */
  next: Cursor | null
  /** Milliseconds until the next beat. */
  delay: number
  /** Whether the voice is speaking, for the level meter. */
  talking: boolean
}

export const START: Cursor = { step: 0, revealed: 0, committed: 0 }

function heard(step: ScriptStep, words: string[], from: number, to: number): string {
  const mishear = step.kind === 'speech' ? step.mishear : undefined
  return words
    .slice(from, to)
    .map((word, i) => mishear?.[from + i] ?? word)
    .join(' ')
}

/** The next beat of the script. `random` (0–1) varies the speaking pace. */
export function beat(script: readonly ScriptStep[], cursor: Cursor, random: () => number): Beat {
  const step = script[cursor.step]
  if (!step) return { commit: '', ghost: '', next: null, delay: 0, talking: false }
  const following: Cursor = { step: cursor.step + 1, revealed: 0, committed: 0 }
  if (step.kind === 'command') {
    // Heard first, then committed: the voice command turns into a paragraph break.
    if (cursor.revealed === 0) {
      return { commit: '', ghost: step.text, next: { ...cursor, revealed: 1 }, delay: 650, talking: true }
    }
    return { commit: step.text, ghost: '', next: following, delay: 350, talking: false }
  }
  const words = step.text.split(' ')
  if (cursor.revealed < words.length) {
    const revealed = cursor.revealed + 1
    const confirmed = Math.max(cursor.committed, revealed - LOOKAHEAD)
    return {
      commit: words.slice(cursor.committed, confirmed).join(' '),
      ghost: heard(step, words, confirmed, revealed),
      next: { step: cursor.step, revealed, committed: confirmed },
      delay: 190 + random() * 170,
      talking: true
    }
  }
  // The speaker paused: everything still unconfirmed is committed, now spelled right.
  return { commit: words.slice(cursor.committed).join(' '), ghost: '', next: following, delay: 520, talking: false }
}

/** What stopping mid-sentence commits: the words already heard, spelled right. */
export function flush(script: readonly ScriptStep[], cursor: Cursor): string {
  const step = script[cursor.step]
  if (step?.kind !== 'speech') return ''
  return step.text.split(' ').slice(cursor.committed, cursor.revealed).join(' ')
}
