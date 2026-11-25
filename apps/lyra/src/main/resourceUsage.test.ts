import { describe, expect, it } from 'vitest'
import { pressure, summarizeProcesses } from './resourceUsage'

const mb = (value: number): { workingSetSize: number } => ({ workingSetSize: value * 1024 })

describe('summarizeProcesses', () => {
  it('adds up processes by kind, and all of them', () => {
    const usage = summarizeProcesses([
      { type: 'Browser', cpu: { percentCPUUsage: 120.4 }, memory: mb(300) },
      { type: 'Tab', cpu: { percentCPUUsage: 10 }, memory: mb(150) },
      { type: 'Tab', cpu: { percentCPUUsage: 5.2 }, memory: mb(50) },
      { type: 'GPU', cpu: { percentCPUUsage: 40 }, memory: mb(900) },
      { type: 'Utility', name: 'Lyra speaker worker', cpu: { percentCPUUsage: 95 }, memory: mb(400) },
      { type: 'Utility', name: 'Network Service', cpu: { percentCPUUsage: 1 }, memory: mb(30) }
    ])
    expect(usage).toEqual({
      main: { cpu: 120, mb: 300 },
      windows: { cpu: 15, mb: 200 },
      gpu: { cpu: 40, mb: 900 },
      'speaker-worker': { cpu: 95, mb: 400 },
      other: { cpu: 1, mb: 30 },
      // 120.4 + 10 + 5.2 + 40 + 95 + 1 = 271.6; 300 + 150 + 50 + 900 + 400 + 30 = 1830
      total: { cpu: 272, mb: 1830 }
    })
  })

  it('is empty for no processes', () => {
    expect(summarizeProcesses([])).toEqual({})
  })
})

describe('pressure', () => {
  const calm = { freeMb: 8000, totalMb: 16000, load1: 2, cores: 8, diskFreeGb: 50, thermal: 'nominal' }

  it('finds nothing on a calm machine', () => {
    expect(pressure(calm)).toEqual([])
  })

  it('names what is short', () => {
    // 5% of 16000 MB is 800 MB; 1.5 × 8 cores is a load of 12.
    expect(pressure({ ...calm, freeMb: 700 })).toEqual(['memory'])
    expect(pressure({ ...calm, load1: 12.5 })).toEqual(['cpu'])
    expect(pressure({ ...calm, diskFreeGb: 1.5 })).toEqual(['disk'])
    expect(pressure({ ...calm, thermal: 'serious' })).toEqual(['heat'])
    expect(pressure({ ...calm, freeMb: 100, diskFreeGb: 0.2, thermal: 'critical' })).toEqual(['memory', 'disk', 'heat'])
  })

  it('never calls memory short above half a gigabyte free on a small machine', () => {
    // 5% of 4000 MB is 200 MB, under the 512 MB floor.
    expect(pressure({ ...calm, totalMb: 4000, freeMb: 600 })).toEqual([])
    expect(pressure({ ...calm, totalMb: 4000, freeMb: 400 })).toEqual(['memory'])
  })

  it('ignores what it has no reading for', () => {
    expect(pressure({ ...calm, freeMb: null, load1: 0, diskFreeGb: null, thermal: null })).toEqual([])
  })
})
