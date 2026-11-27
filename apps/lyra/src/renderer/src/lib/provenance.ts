import { PROVIDERS, type ProviderId } from '../../../shared/ai'

/**
 * Where machine output is made, said at the point of use (the interface system's provenance
 * chips). Local is a quiet badge of quality; anything that leaves the computer names where it
 * goes. A server the user runs counts as leaving: Lyra can't see where it forwards text.
 */
export type Provenance = { kind: 'local' | 'cloud'; label: string }

type Engine = {
  notesEngine: 'off' | 'local' | 'cloud'
  cloudProvider: ProviderId
  cloudBaseUrl: string | null
}

/** The status bar's one-line summary of where everything runs. */
export function overallProvenance(engine: Engine): Provenance {
  if (engine.notesEngine !== 'cloud') return { kind: 'local', label: 'Everything on this computer' }
  return { kind: 'cloud', label: `Summaries go to ${destination(engine)}` }
}

function destination(engine: Engine): string {
  if (engine.cloudProvider !== 'openai-compatible') return PROVIDERS[engine.cloudProvider].label
  if (!engine.cloudBaseUrl) return 'a server'
  try {
    return new URL(engine.cloudBaseUrl).host
  } catch {
    return 'a server'
  }
}
