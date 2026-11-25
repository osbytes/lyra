import type { ProcessMetric } from 'electron'
import { availableParallelism, totalmem } from 'node:os'
import { metricsReader } from './appMetrics'
import type { AppUsage, ProcessUsage, UsageSample } from '../shared/types'

type Kind = ProcessUsage['kind']

/** Display order; Whisper runs in the main process, so it is listed first. */
const KINDS: readonly Kind[] = [
  'main',
  'windows',
  'speakers',
  'notes',
  'search',
  'graphics',
  'other'
]

function kindOf(metric: ProcessMetric): Kind {
  switch (metric.type) {
    case 'Browser':
      return 'main'
    case 'Tab':
      return 'windows'
    case 'GPU':
      return 'graphics'
    case 'Utility':
      // `serviceName` from utilityProcess.fork in meeting/speakers.ts, meeting/notesLocal.ts and
      // searchIndex/service.ts.
      if (metric.name === 'Lyra speaker worker') return 'speakers'
      if (metric.name === 'Lyra notes worker') return 'notes'
      if (metric.name === 'Lyra search index') return 'search'
      return 'other'
    case 'Zygote':
    case 'Sandbox helper':
    case 'Pepper Plugin':
    case 'Pepper Plugin Broker':
    case 'Unknown':
      return 'other'
  }
}

/**
 * Sampled in the background rather than on request, so the history shows what Lyra did while
 * Settings was closed. One metrics read every 5 seconds is too cheap to show up in the readings.
 */
const INTERVAL_MS = 5000
const KEEP = (30 * 60 * 1000) / INTERVAL_MS

const samples: UsageSample[] = []
const readMetrics = metricsReader()
let timer: NodeJS.Timeout | null = null

export function startUsageSampler(): void {
  if (timer) return
  // The first reading only sets Electron's CPU baseline (it reports 0), so it is not kept.
  sample()
  timer = setInterval(() => {
    samples.push(sample())
    if (samples.length > KEEP) samples.shift()
  }, INTERVAL_MS)
}

export function appUsage(): AppUsage {
  return { intervalMs: INTERVAL_MS, totalMemoryBytes: totalmem(), samples }
}

/**
 * On macOS and Linux Electron reports CPU per process as a share of one core, so a busy Whisper
 * pass can read 400%; dividing by the core count gives the share of the whole computer, as
 * Activity Monitor's total and Task Manager do. On Windows Chromium has already divided
 * (measured: a 95%-of-one-core loop on 16 cores reads 6%).
 */
function sample(): UsageSample {
  const cores = process.platform === 'win32' ? 1 : Math.max(1, availableParallelism())
  const totals = new Map<Kind, ProcessUsage>()
  for (const metric of readMetrics()) {
    const kind = kindOf(metric)
    const entry = totals.get(kind) ?? { kind, cpuPercent: 0, memoryBytes: 0 }
    entry.cpuPercent += metric.cpu.percentCPUUsage / cores
    // workingSetSize is in kilobytes.
    entry.memoryBytes += metric.memory.workingSetSize * 1024
    totals.set(kind, entry)
  }
  const processes = KINDS.flatMap((kind) => totals.get(kind) ?? [])
  return {
    at: Date.now(),
    cpuPercent: processes.reduce((sum, entry) => sum + entry.cpuPercent, 0),
    memoryBytes: processes.reduce((sum, entry) => sum + entry.memoryBytes, 0),
    processes
  }
}
