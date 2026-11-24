import { useEffect, useState } from 'react'
import { PROVIDERS } from '../../../shared/ai'
import type { HotkeyStatus, Settings } from '../../../shared/types'

/** Settings tabs, so a problem can point at where it's fixed. */
export type SettingsTab = 'general' | 'sessions' | 'people'

export type SettingsIssue = { tab: SettingsTab; message: string }

const keyListeners = new Set<() => void>()

/** Call after an API key is saved or removed, so the issue badge updates. */
export function keyChanged(): void {
  for (const listener of keyListeners) listener()
}

/** The global shortcut is taken by another app: its registration error, else null. */
export function hotkeyProblem(settings: Settings, statuses: readonly HotkeyStatus[]): string | null {
  const status = statuses.at(0)
  return status?.accelerator === settings.hotkey && !status.registered ? status.error : null
}

/** Hotkey registration, as main reports it. */
export function useHotkeyStatus(): HotkeyStatus[] {
  const [statuses, setStatuses] = useState<HotkeyStatus[]>([])
  useEffect(() => {
    window.api.getHotkeyStatus().then(setStatuses, () => {
      // No global shortcut in this run (tests, screenshots): nothing to report.
    })
    return window.api.onHotkeyStatus(setStatuses)
  }, [])
  return statuses
}

/**
 * Settings that stop something from working: the session shortcut didn't register, or cloud
 * summaries are on without what they need (a key, a model, a server address). Badges the Settings
 * button and the tab that fixes it.
 */
export function useSettingsIssues(settings: Settings | null): SettingsIssue[] {
  const statuses = useHotkeyStatus()
  const [hasKey, setHasKey] = useState(true)

  const provider = settings?.cloudProvider ?? 'anthropic'
  useEffect(() => {
    const check = (): void => {
      void window.api.keySource(provider).then((source) => {
        setHasKey(source !== null)
      })
    }
    check()
    keyListeners.add(check)
    return () => {
      keyListeners.delete(check)
    }
  }, [provider])

  if (!settings) return []
  const issues: SettingsIssue[] = []
  const hotkey = hotkeyProblem(settings, statuses)
  if (hotkey) issues.push({ tab: 'general', message: hotkey })
  if (settings.notesEngine === 'cloud') {
    const info = PROVIDERS[settings.cloudProvider]
    if (info.needsKey && !hasKey) {
      issues.push({ tab: 'sessions', message: `Summaries with ${info.label} need an API key.` })
    }
    if (!settings.cloudModel && !info.defaultModel) {
      issues.push({ tab: 'sessions', message: `Choose a ${info.label} model for summaries.` })
    }
    if (info.needsBaseUrl && !settings.cloudBaseUrl) {
      issues.push({ tab: 'sessions', message: 'Summaries need the server address.' })
    }
  }
  return issues
}
