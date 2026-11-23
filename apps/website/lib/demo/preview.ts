import { summaryOf, type ExportContext } from './export'
import type { Session } from './types'

/** The sidebar's one-line preview: the start of the notes, or of the meeting notes. */
export function previewOf(session: Session, ctx: ExportContext): string {
  return [summaryOf(session, ctx), session.body]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** Tags across every session, most used first (the sidebar filter and the tag picker). */
export function tagCounts(sessions: Session[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const session of sessions) for (const tag of session.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
