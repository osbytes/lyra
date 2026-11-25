import type { ProcessUsage } from '../shared/types'

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

export type { ProcessUsage }

/** The fields of a graphics adapter in Electron's basic GPU info this needs. */
export type GpuDevice = { active?: boolean | undefined; vendorId: number; deviceId: number }

const GPU_VENDORS: Readonly<Record<number, string>> = {
  0x1002: 'AMD',
  0x106b: 'Apple',
  0x10de: 'NVIDIA',
  0x8086: 'Intel'
}

/**
 * The adapter in use, as its maker and PCI device id (the system gives ids, not names): the
 * active one, else the first. Null with none, or one with no ids (Apple silicon reports zeros,
 * and its CPU's name already says which GPU it is).
 */
export function gpuLabel(devices: readonly GpuDevice[]): string | null {
  const device = devices.find((entry) => entry.active === true) ?? devices[0]
  if (!device || (device.vendorId === 0 && device.deviceId === 0)) return null
  const hex = (value: number): string => `0x${value.toString(16).padStart(4, '0')}`
  return `${GPU_VENDORS[device.vendorId] ?? `vendor ${hex(device.vendorId)}`} ${hex(device.deviceId)}`
}

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
