/**
 * The "Sections" part of a generated summary, read back from its plain text
 * (`renderNotes` in src/main/meeting/notesFormat.ts writes `- 12:40 Title: what it covered`).
 * The file keeps them in the summary; the window shows them as a table of contents on the
 * transcript instead.
 */

export const SECTIONS_HEADING = 'Sections'

export type SummarySection = {
  /** Whole seconds from the recording's start, as the summary wrote them. */
  start: number
  title: string
  summary: string
}

/** `0:05` → 5, `12:40` → 760, `1:02:03` → 3723; null when it isn't a clock time. */
export function parseClock(text: string): number | null {
  if (!/^\d+(?::[0-5]\d){1,2}$/.test(text)) return null
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/** The summary's sections, in order; none when it has no Sections heading. */
export function summarySections(summary: string): SummarySection[] {
  const sections: SummarySection[] = []
  let inside = false
  for (const raw of summary.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const bullet = /^[-*] (\S+) (.+)$/.exec(line)
    if (!bullet) {
      // Any other line that isn't a bullet is the next heading.
      inside = line === SECTIONS_HEADING
      continue
    }
    if (!inside) continue
    const start = parseClock(bullet[1] ?? '')
    if (start === null) continue
    const rest = bullet[2] ?? ''
    const at = rest.indexOf(': ')
    sections.push(
      at === -1
        ? { start, title: rest.trim(), summary: '' }
        : { start, title: rest.slice(0, at).trim(), summary: rest.slice(at + 2).trim() }
    )
  }
  return sections
}
