import { useState } from 'react'
import type { ModelFeature } from '../../../shared/types'
import { useModelStatus } from '../hooks/useModelStatus'
import { ipcErrorMessage } from '../lib/ipcError'
import { log } from '../lib/log'
import { modelLine } from '../lib/modelStatusText'

const ACTION_LABELS = { cancel: 'Cancel', retry: 'Retry', download: 'Download now' } as const

/**
 * The line under a setting whose model downloads on first use: how far the download has got
 * (with Cancel), then any work after it, then Ready, or what went wrong (with Retry).
 */
export function ModelStatusLine({ feature }: { feature: ModelFeature }) {
  const status = useModelStatus(feature)
  const [pending, setPending] = useState(false)
  if (!status) return null
  const line = modelLine(status)
  const act = async (): Promise<void> => {
    setPending(true)
    try {
      if (line.action === 'cancel') await window.api.cancelModelDownload(status.model)
      else await window.api.retryModel(feature)
    } catch (caught) {
      log('settings', 'model action failed', { feature, action: line.action, error: ipcErrorMessage(caught) })
    } finally {
      setPending(false)
    }
  }
  return (
    <div className={`settings-model is-${line.tone}`}>
      <div className="settings-model-line">
        {/* Announced when the state changes, not on every percent. */}
        <span className="visually-hidden" role="status">
          {status.state === 'downloading' ? 'Downloading' : status.state === 'reading' ? 'Reading your sessions' : line.text}
        </span>
        <span className="settings-model-text" aria-hidden="true">
          {line.text}
        </span>
        {line.action ? (
          <button className="btn ghost settings-model-action" type="button" disabled={pending} onClick={() => void act()}>
            {ACTION_LABELS[line.action]}
          </button>
        ) : null}
      </div>
      {line.progress === null ? null : (
        <div className="settings-model-bar" aria-hidden="true">
          <span style={{ width: `${String(line.progress * 100)}%` }} />
        </div>
      )}
    </div>
  )
}
