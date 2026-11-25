import { dialog, type BrowserWindow } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import {
  appsInFile,
  IgnoredAppsFile,
  ignoredAppsFile,
  mergeIgnoredApps
} from '../shared/ignoredApps'
import type { ExportIgnoredResult, ImportIgnoredResult } from '../shared/types'
import { log } from './log'
import { getSettings, updateSettings } from './settings'

/** Far larger than any real list; a bigger file isn't one. */
const MAX_FILE_BYTES = 256 * 1024
const FILTERS = [{ name: 'Lyra app list', extensions: ['json'] }]

/** Writes the "Don't ask" list to `path`. */
export async function exportIgnoredAppsTo(path: string): Promise<ExportIgnoredResult> {
  const apps = getSettings().micPrompt.ignoredApps
  await writeFile(path, `${JSON.stringify(ignoredAppsFile(apps), null, 2)}\n`, 'utf8')
  log('prompts', 'exported ignored apps', { count: apps.length })
  return { status: 'saved', count: apps.length }
}

/** Adds the names in the file at `path` to the "Don't ask" list; never removes any. */
export async function importIgnoredAppsFrom(path: string): Promise<ImportIgnoredResult> {
  if ((await stat(path)).size > MAX_FILE_BYTES) {
    return { status: 'invalid', message: 'That file is too large to be an app list.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { status: 'invalid', message: 'That file isn’t JSON.' }
  }
  const file = IgnoredAppsFile.safeParse(raw)
  if (!file.success) {
    return { status: 'invalid', message: 'That file isn’t a Lyra app list.' }
  }
  const prompt = getSettings().micPrompt
  const { apps, added } = mergeIgnoredApps(prompt.ignoredApps, appsInFile(file.data))
  if (added) await updateSettings({ micPrompt: { ...prompt, ignoredApps: apps } })
  log('prompts', 'imported ignored apps', { added, total: apps.length })
  return { status: 'imported', added, total: apps.length }
}

export async function exportIgnoredApps(win: BrowserWindow | null): Promise<ExportIgnoredResult> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export apps Lyra doesn’t ask about',
    defaultPath: 'lyra-ignored-apps.json',
    filters: FILTERS
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { status: 'cancelled' }
  return exportIgnoredAppsTo(result.filePath)
}

export async function importIgnoredApps(win: BrowserWindow | null): Promise<ImportIgnoredResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import apps Lyra doesn’t ask about',
    filters: FILTERS,
    properties: ['openFile']
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = result.filePaths[0]
  if (result.canceled || !path) return { status: 'cancelled' }
  return importIgnoredAppsFrom(path)
}
