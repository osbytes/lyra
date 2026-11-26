import { app, type ProcessMetric } from 'electron'

/**
 * Electron's CPU figures cover the time since the previous `getAppMetrics` call by anyone, so two
 * callers (the Performance graphs and the resource log) would each see only a slice of the time.
 * Every call goes through here instead: each reading is added to a running total per process, and
 * each reader gets the average since its own last read.
 */
const busyTotals = new Map<number, number>()
let lastCallAt = 0

function poll(): { at: number; metrics: ProcessMetric[] } {
  const at = Date.now()
  const metrics = app.getAppMetrics()
  if (lastCallAt) {
    for (const metric of metrics) {
      const busy = metric.cpu.percentCPUUsage * (at - lastCallAt)
      busyTotals.set(metric.pid, (busyTotals.get(metric.pid) ?? 0) + busy)
    }
  }
  lastCallAt = at
  return { at, metrics }
}

/** A `getAppMetrics` of one's own: CPU is the average since this reader's previous call (0 on the first). */
export function metricsReader(): () => ProcessMetric[] {
  let seen = new Map<number, number>()
  let readAt = 0
  return () => {
    const { at, metrics } = poll()
    const span = at - readAt
    const out = metrics.map((metric) => {
      const busy = (busyTotals.get(metric.pid) ?? 0) - (seen.get(metric.pid) ?? 0)
      const percentCPUUsage = readAt && span > 0 ? busy / span : 0
      return { ...metric, cpu: { ...metric.cpu, percentCPUUsage } }
    })
    seen = new Map(metrics.map((metric) => [metric.pid, busyTotals.get(metric.pid) ?? 0]))
    readAt = at
    return out
  }
}
