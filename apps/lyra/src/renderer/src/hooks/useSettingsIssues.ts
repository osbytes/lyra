import { useEffect, useState } from 'react'
import type { HotkeyStatus, Settings } from '../../../shared/types'

/** Settings tabs, so a problem can point at where it's fixed. */
export type SettingsTab = 'general' | 'sessions' | 'people'

export type SettingsIssue = { tab: SettingsTab; message: string }

const keyListeners = new Set<() => void>()

/** Call after the Claude API key is saved or removed, so the issue badge updates. */
export function claudeKeyChanged(): void {
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
 * Settings that stop something from working: the session shortcut didn't register, or Claude
 * summaries are on without a key. Badges the Settings button and the tab that fixes it.
 */
export function useSettingsIssues(settings: Settings | null): SettingsIssue[] {
  const statuses = useHotkeyStatus()
  const [hasKey, setHasKey] = useState(true)

  useEffect(() => {
    const check = (): void => {
      void window.api.claudeKeySource().then((source) => {
        setHasKey(source !== null)
      })
    }
    check()
    keyListeners.add(check)
    return () => {
      keyListeners.delete(check)
    }
  }, [])

  if (!settings) return []
  const issues: SettingsIssue[] = []
  const hotkey = hotkeyProblem(settings, statuses)
  if (hotkey) issues.push({ tab: 'general', message: hotkey })
  if (settings.notesEngine === 'claude' && !hasKey) {
    issues.push({ tab: 'sessions', message: 'Summaries with Claude need an API key.' })
  }
  return issues
}
