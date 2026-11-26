import { BrowserWindow } from 'electron'
import type { ModelFeature, ModelStatus } from '../shared/types'
import { DownloadCancelledError, type DownloadProgress, type ModelFile } from './models'

/**
 * Where each download-on-first-use feature's model stands, for Settings: broadcast on
 * `models:status` as it changes, and kept so a window opened later can ask (`models:status:get`).
 */

const statuses = new Map<ModelFeature, ModelStatus>()
const retries = new Map<ModelFeature, () => void>()

export function setModelStatus(status: ModelStatus): void {
  statuses.set(status.feature, status)
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
