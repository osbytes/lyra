import { BrowserWindow } from 'electron'
import type { ModelFeature, ModelStatus, WhisperStatus } from '../shared/types'
import { bytesDetail } from '../shared/activity'
import { activityItem, clear, end, onActivityAction, report } from './activity'
import { cancelModelDownload, DownloadCancelledError, type DownloadProgress, type ModelFile } from './models'

/**
 * Where each download-on-first-use feature's model stands, for Settings: broadcast on
 * `models:status` as it changes, and kept so a window opened later can ask (`models:status:get`).
 */

const statuses = new Map<ModelFeature, ModelStatus>()
const retries = new Map<ModelFeature, () => void>()

/** How each feature's model reads in Activity. */
const WORDS: Record<ModelFeature, { name: string; ready: string }> = {
  semanticSearch: { name: 'the search model', ready: 'Search by meaning is ready' },
  localNotes: { name: 'the notes model', ready: 'The notes model is ready' }
}

/** Mirrors a model's status into Activity, so it stays visible once Settings is closed. */
function reportActivity(status: ModelStatus): void {
  const id = `model:${status.feature}`
  const words = WORDS[status.feature]
  const base = { id, kind: 'model' as const, origin: 'settings' as const }
  switch (status.state) {
    case 'downloading':
      report({
        ...base,
        title: `Downloading ${words.name}`,
        detail: bytesDetail(status.received, status.total),
        progress: status.total ? status.received / status.total : null,
        actions: ['cancel']
      })
      return
    case 'reading':
      report({
        ...base,
        title: 'Reading your sessions for search',
        detail: status.pausedFor
          ? `${String(status.done)} of ${String(status.total)} · paused while ${status.pausedFor === 'recording' ? 'recording' : 'on battery'}`
          : `${String(status.done)} of ${String(status.total)}`,
        progress: status.total ? status.done / status.total : null
      })
      return
    case 'ready':
      // Ready at startup (already downloaded) is no news: only an ending of work in Activity is.
      if (activityItem(id)) end({ ...base, title: words.ready }, 'done')
      return
    case 'error':
      end({ ...base, title: `Couldn't get ${words.name} ready`, detail: status.message, actions: ['retry'] }, 'failed')
      return
    case 'cancelled':
    case 'missing':
      clear(id)
      return
  }
}

/** The speech model's file, once its download has been reported (it has no retry of its own). */
let speechModel: string | null = null

/**
 * The speech model's download, reported to Activity. Dictation shows it in the dock as well;
 * this keeps it findable when the window is elsewhere.
 */
export function reportSpeechModel(status: WhisperStatus, model: string): void {
  const base = { id: 'model:speech', kind: 'model' as const, origin: 'app' as const }
  switch (status.state) {
    case 'downloading':
      speechModel = model
      report({
        ...base,
        title: 'Downloading the speech model',
        detail: bytesDetail(status.received, status.total),
        progress: status.total ? status.received / status.total : null,
        actions: ['cancel']
      })
      return
    case 'idle':
      if (activityItem(base.id)?.state === 'running') end({ ...base, title: 'The speech model is ready' }, 'done')
      return
    case 'error':
      end({ ...base, title: "Couldn't get the speech model", detail: status.message }, 'failed')
      return
  }
}

onActivityAction('model', (item, action) => {
  if (item.id === 'model:speech') {
    if (action === 'cancel' && speechModel) cancelModelDownload(speechModel)
    return
  }
  const feature = statuses.get(item.id === 'model:localNotes' ? 'localNotes' : 'semanticSearch')
  if (!feature) return
  if (action === 'cancel') cancelModelDownload(feature.model)
  if (action === 'retry') retryModel(feature.feature)
})

export function setModelStatus(status: ModelStatus): void {
  statuses.set(status.feature, status)
  reportActivity(status)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('models:status', status)
}

export function modelStatuses(): ModelStatus[] {
  return [...statuses.values()]
}

/** A download progress callback that reports `model` as downloading for `feature`. */
export function downloadReporter(feature: ModelFeature, model: ModelFile): DownloadProgress {
  return (received, total) => {
    setModelStatus({ feature, model: model.name, state: 'downloading', received, total })
  }
}

/** Reports a failed download or load: a cancel by the user is not an error. */
export function reportModelFailure(feature: ModelFeature, model: ModelFile, error: unknown): void {
  setModelStatus(
    error instanceof DownloadCancelledError
      ? { feature, model: model.name, state: 'cancelled' }
      : { feature, model: model.name, state: 'error', message: error instanceof Error ? error.message : String(error) }
  )
}

/** What Retry does for `feature`; set by the module that owns its model. */
export function onModelRetry(feature: ModelFeature, run: () => void): void {
  retries.set(feature, run)
}

export function retryModel(feature: ModelFeature): void {
  retries.get(feature)?.()
}
