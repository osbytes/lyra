import { useState } from 'react'
import type { ModelFeature } from '../../../shared/types'
import { useModelStatus } from '../hooks/useModelStatus'
import { ipcErrorMessage } from '../lib/ipcError'
import { log } from '../lib/log'
import { modelLine } from '../lib/modelStatusText'
import { cn } from '../lib/utils'
import { ErrorIcon } from './Icons'
import { Button } from './ui/button'
import { Progress } from './ui/progress'

const ACTION_LABELS = { cancel: 'Cancel', retry: 'Retry', download: 'Download now' } as const

/**
 * The status under a setting whose model downloads on first use: how far the download has got
 * (with Cancel), then any work after it, or what went wrong (with Retry). Once the model is
 * ready there is nothing to say, so nothing takes up room; screen readers still hear "Ready".
 */
export function ModelStatusLine({ feature }: { feature: ModelFeature }) {
  const status = useModelStatus(feature)
  const [pending, setPending] = useState(false)
  if (!status) return null
  const line = modelLine(status)
  const announced =
    status.state === 'downloading' ? 'Downloading' : status.state === 'reading' ? 'Reading your sessions' : line.text
  if (line.tone === 'ready' && !line.action) {
    return (
      <span className="visually-hidden" role="status">
        {announced}
      </span>
    )
  }
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
    <div className={cn('settings-model grid gap-1.5 pb-3', `is-${line.tone}`)}>
      <div className="flex min-h-[26px] items-center gap-2 text-[12.5px]">
        {/* Announced when the state changes, not on every percent. */}
        <span className="visually-hidden" role="status">
          {announced}
        </span>
        {line.tone === 'error' ? <ErrorIcon className="shrink-0 text-destructive" /> : null}
        <span
          className={cn('min-w-0 flex-1', line.tone === 'error' ? 'text-destructive' : 'text-text-2')}
          aria-hidden="true"
        >
          {line.text}
        </span>
        {line.action ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void act()}>
            {ACTION_LABELS[line.action]}
          </Button>
        ) : null}
      </div>
      {line.progress === null ? null : <Progress value={line.progress * 100} aria-hidden="true" />}
    </div>
  )
}
