/**
 * A session's own work (labeling speakers, writing its summary) as Activity sees it: the
 * session's status line keeps the detail, and Activity keeps the task findable from anywhere
 * and its failure visible until it's dealt with (docs/STATES.md).
 */
import type { MeetingStatus } from '../../shared/types'
import { activityItem, clear, end, report } from '../activity'

/** The notes run's own words for its two non-failures that travel as `error`. */
export const SUMMARY_STOPPED = 'Summary stopped'
export const SUMMARY_KEPT = 'The summary was edited while it was being written, so it was kept'

/**
 * Mirrors one meeting status into Activity. `announce`: whether a successful ending is news
 * (a summary the person asked for), or quiet (automatic work: the result is its own sign).
 */
export function reportMeetingStatus(status: MeetingStatus, announce = false): void {
  const notes = status.task === 'notes'
  const id = `${status.task}:${status.pageId}`
  const base = { id, kind: status.task, origin: 'session' as const, pageId: status.pageId }
  const progress = status.progress > 0 ? status.progress : null
  switch (status.state) {
    case 'downloading':
      // The notes model's download is its own Activity row (modelStatus.ts).
      if (!notes) report({ ...base, title: 'Downloading the speaker models', progress })
      return
    case 'diarizing':
      report({ ...base, title: 'Labeling speakers', detail: 'Finding who spoke when' })
      return
    case 'transcribing':
      report({ ...base, title: 'Labeling speakers', detail: 'Transcribing each speaker', progress })
      return
    case 'summarizing':
      report({ ...base, title: 'Writing the summary', detail: status.message ?? null, progress, actions: ['cancel'] })
      return
    case 'done':
      if (announce && activityItem(id)) end({ ...base, title: 'Summary written', actions: ['open'] }, 'done')
      else clear(id)
      return
    case 'error':
      if (status.message === SUMMARY_STOPPED) {
        clear(id)
        return
      }
      if (status.message === SUMMARY_KEPT) {
        end({ ...base, title: 'Kept your edited summary', detail: status.message, actions: ['open'] }, 'done')
        return
      }
      end(
        {
          ...base,
          title: notes ? "Couldn't write the summary" : "Couldn't label speakers",
          detail: status.message ?? null,
          actions: notes ? ['open', 'retry'] : ['open']
        },
        'failed'
      )
      return
  }
}
