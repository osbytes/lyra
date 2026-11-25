/**
 * Turns Electron's per-process metrics into one compact log entry. Kept apart from the Electron
 * code that samples them so it's unit-tested.
 */

/** The fields of Electron's `ProcessMetric` this needs. */
export type ProcessSample = {
  type: string
  /** Set for utility processes ("Lyra speaker worker"). */
  name?: string
  cpu: { percentCPUUsage: number }
  /** Kilobytes. */
  memory: { workingSetSize: number }
}

export type ProcessUsage = { cpu: number; mb: number }

/** Lyra's own processes by a short stable name, for a log line someone can read. */
function label(sample: ProcessSample): string {
  if (sample.type === 'Browser') return 'main'
  if (sample.type === 'Tab') return 'windows'
  if (sample.type === 'GPU') return 'gpu'
  if (sample.type === 'Utility' && sample.name?.startsWith('Lyra ')) {
    return sample.name.slice('Lyra '.length).replaceAll(' ', '-')
  }
  return 'other'
}

/**
 * CPU (percent of one core, so 250 is two and a half cores) and memory (MB) per kind of process,
 * with the windows added together, plus the total. Whisper runs in main and on the GPU process.
 */
export function summarizeProcesses(samples: readonly ProcessSample[]): Record<string, ProcessUsage> {
  const usage = new Map<string, ProcessUsage>()
  const add = (key: string, sample: ProcessSample): void => {
    const current = usage.get(key) ?? { cpu: 0, mb: 0 }
    current.cpu += sample.cpu.percentCPUUsage
    current.mb += sample.memory.workingSetSize / 1024
    usage.set(key, current)
  }
  for (const sample of samples) {
    add(label(sample), sample)
    add('total', sample)
  }
  return Object.fromEntries(
    [...usage].map(([key, value]) => [key, { cpu: Math.round(value.cpu), mb: Math.round(value.mb) }])
  )
}

/**
 * Whether the machine itself looks short of something, worth a log line of its own: little
 * memory left, more runnable work than cores (macOS and Linux only; Windows reports no load),
 * the disk nearly full, or the system throttling for heat.
 */
export function pressure(sample: {
  /** Null where the number can't be trusted to mean "available" (macOS, see resources.ts). */
  freeMb: number | null
  totalMb: number
  load1: number
  cores: number
  diskFreeGb: number | null
  thermal: string | null
}): string[] {
  const reasons: string[] = []
  if (sample.freeMb !== null && sample.freeMb < Math.max(512, sample.totalMb * 0.05)) reasons.push('memory')
  if (sample.cores > 0 && sample.load1 > sample.cores * 1.5) reasons.push('cpu')
  if (sample.diskFreeGb !== null && sample.diskFreeGb < 2) reasons.push('disk')
  if (sample.thermal === 'serious' || sample.thermal === 'critical') reasons.push('heat')
  return reasons
}
