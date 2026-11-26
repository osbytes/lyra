import { app, shell } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Diagnostics, DiagnosticsPlace, RevealTarget } from '../shared/types'
import { diagnosticsText, notesEngineLabel, shortenHome } from './diagnosticsText'
import { log, logPath } from './log'
import { modelsDir } from './models'
import { notesDir } from './pages'
import { machineInfo, sampleResources } from './resources'
import { getSettings } from './settings'
import { MODEL_LABEL, whisperBackend } from './whisper'

/**
 * Settings → About: versions, the machine and what it's using, where Lyra keeps its files and
 * how much room they take. Sizes come
 * from an async walk that stops after `MAX_ENTRIES`, so a huge folder costs a bounded amount of
 * work and the main process keeps answering while it runs. Asked for only when the section opens.
 */

const MAX_ENTRIES = 20_000

/** Whether Whisper has run since launch; until then its backend is only a plan. */
let whisperUsed = false

/** Called once Whisper has loaded or transcribed something. */
export function noteWhisperUsed(): void {
  whisperUsed = true
}

function logsDir(): string {
  const path = logPath()
  return path === null ? join(app.getPath('userData'), 'logs') : dirname(path)
}

/** Where the search index lives (`searchIndex/service.ts` keeps `lyra.db` in it). */
function indexDir(): string {
  return join(app.getPath('userData'), 'index')
}

type Size = { bytes: number; complete: boolean }

/** Bytes under `root`, without following links; stops counting after `budget.left` entries. */
async function folderSize(root: string, budget: { left: number }): Promise<Size> {
  let bytes = 0
  const pending = [root]
  while (pending.length) {
    const dir = pending.pop()
    if (dir === undefined) break
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (budget.left-- <= 0) return { bytes, complete: false }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) bytes += (await stat(path).catch(() => null))?.size ?? 0
    }
  }
  return { bytes, complete: true }
}

/** Recorded audio: each session's `audio/` folder under `<notes>/.sessions`. */
async function sessionAudioSize(sessions: string, budget: { left: number }): Promise<Size> {
  let bytes = 0
  let complete = true
  const entries = await readdir(sessions, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (budget.left <= 0) return { bytes, complete: false }
    const size = await folderSize(join(sessions, entry.name, 'audio'), budget)
    bytes += size.bytes
    complete &&= size.complete
  }
  return { bytes, complete }
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const started = Date.now()
  const home = homedir()
  const sessions = join(notesDir(), '.sessions')
  const folders: { id: DiagnosticsPlace['id']; label: string; path: string; size: (budget: { left: number }) => Promise<Size> }[] = [
    { id: 'models', label: 'Models', path: modelsDir(), size: (budget) => folderSize(modelsDir(), budget) },
    { id: 'audio', label: 'Session audio', path: sessions, size: (budget) => sessionAudioSize(sessions, budget) },
    { id: 'index', label: 'Search index', path: indexDir(), size: (budget) => folderSize(indexDir(), budget) },
    { id: 'logs', label: 'Logs', path: logsDir(), size: (budget) => folderSize(logsDir(), budget) }
  ]
  const places: DiagnosticsPlace[] = []
  for (const folder of folders) {
    // Each folder gets its own budget, so a vast audio folder can't leave the others uncounted.
    const size = await folder.size({ left: MAX_ENTRIES })
    places.push({ id: folder.id, label: folder.label, path: shortenHome(folder.path, home), ...size })
  }
  const info: Omit<Diagnostics, 'text'> = {
    version: app.getVersion(),
    os: `${process.platform} ${process.getSystemVersion()}`,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    whisper: { model: MODEL_LABEL, backend: whisperUsed ? whisperBackend() : null },
    notesEngine: notesEngineLabel(getSettings()),
    machine: await machineInfo(),
    resources: await sampleResources('diagnostics').catch(() => null),
    places
  }
  log('diagnostics', 'gathered', { ms: Date.now() - started })
  return { ...info, text: diagnosticsText(info) }
}

/** Opens one of Lyra's own folders, chosen here: the renderer names which, never a path. */
export async function revealFolder(target: RevealTarget): Promise<void> {
  const dir = target === 'logs' ? logsDir() : modelsDir()
  await mkdir(dir, { recursive: true })
  const error = await shell.openPath(dir)
  if (error) throw new Error(error)
}
