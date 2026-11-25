import type { NotesServer, NotesTestResult, ServerModels } from '../shared/types'
import { config } from './config'
import { log } from './log'
import { createLocalNotesWriter } from './meeting/notesLocal'
import { isOllama } from './meeting/ollama'
import { chooseWriter, detectLocalServers, listLocalModels, testNotesWriter } from './meeting/writers'
import { getApiKey } from './secrets'
import { getSettings } from './settings'

/**
 * Settings → Summaries' "Find servers", model list and "Test". Each runs only when the user
 * clicks it: nothing here is called on startup or on a timer (local-first: no request the user
 * didn't ask for).
 */

/** A test gives up after this; a cold local model can take a while to load. */
const TEST_TIMEOUT_MS = 90_000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Ollama and LM Studio on their usual loopback ports. */
export async function detectServers(): Promise<NotesServer[]> {
  const found = await detectLocalServers()
  log('notes', 'looked for local servers', { found: found.map((server) => server.kind) })
  return found
}

/** The models the server at `baseUrl` offers, and whether it is Ollama. */
export async function listServerModels(baseUrl: string): Promise<ServerModels> {
  const apiKey = await getApiKey('openai-compatible')
  try {
    const [models, ollama] = await Promise.all([listLocalModels(baseUrl, { apiKey }), isOllama(baseUrl)])
    log('notes', 'listed server models', { models: models.length, ollama })
    return { models: [...new Set(models)].sort((a, b) => a.localeCompare(b)), kind: ollama ? 'ollama' : 'other' }
  } catch (error) {
    log('notes', 'could not list server models', message(error))
    throw new Error('Couldn’t get the model list from that address. Is the server running?', {
      cause: error
    })
  }
}

/**
 * Runs one tiny fixed request through the writer the saved settings choose, built exactly as
 * summaries build it. Sends Lyra's own sample text, never anything from the user's sessions.
 */
export async function testWriter(): Promise<NotesTestResult> {
  try {
    const writer = await chooseWriter({
      settings: getSettings,
      apiKey: getApiKey,
      baseUrls: config().baseUrls,
      local: createLocalNotesWriter()
    })
    if (writer === null) return { ok: false, error: 'Summaries are off.' }
    const result = await testNotesWriter(writer, AbortSignal.timeout(TEST_TIMEOUT_MS))
    log('notes', 'tested the notes writer', result.ok ? { ok: true, ms: result.ms } : { ok: false })
    return result.ok ? { ok: true, ms: result.ms, onDevice: writer.onDevice } : result
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}
