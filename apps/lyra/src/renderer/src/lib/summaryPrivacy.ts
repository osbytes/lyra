import { isLoopbackUrl } from '../../../shared/settings'

/**
 * What Settings says leaves the computer when summaries use a server or a hosted provider. Kept
 * pure and in one place so the wording follows the rules in `writers.ts`: only a native Ollama
 * server on this computer counts as on-device; any other server is treated as off-device even
 * on localhost (a local proxy may forward to a hosted model), and typed notes go only to
 * on-device writers.
 */

/** What Lyra has learned about the server at an address: from Find servers, the model list or Test. */
export type ServerKind = 'ollama' | 'other' | 'unknown'

export type PrivacyNote = { tone: 'info' | 'warning'; text: string }

/** Titles are suggested for every recording, so the copy says so wherever text leaves Lyra. */
const TITLES = 'to write summaries, and to suggest a title after each recording, including plain dictation'

/** The host and port only: an address can carry a user name or a path that means nothing here. */
export function serverHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** A hosted provider (Anthropic, OpenAI, Google). */
export function hostedPrivacy(provider: string, needsKey: boolean): string {
  const billing = needsKey ? ' Uses your own API key and is billed to your account.' : ''
  return (
    `Sends the session’s transcript to ${provider}’s API ${TITLES}. Audio, voiceprints and ` +
    `typed notes stay on this computer.${billing}`
  )
}

/** A server the user runs (Ollama, LM Studio, llama.cpp, a proxy), by address and what it is. */
export function serverPrivacy(baseUrl: string | null, kind: ServerKind): PrivacyNote {
  if (baseUrl === null) {
    return {
      tone: 'info',
      text: 'Add the server’s address below, or use Find servers to look for Ollama and LM Studio on this computer.'
    }
  }
  const host = serverHost(baseUrl)
  if (!isLoopbackUrl(baseUrl)) {
    return {
      tone: 'warning',
      text:
        `Sends the session’s transcript to the server at ${host}, on another computer, ${TITLES}. ` +
        'Audio, voiceprints and typed notes stay on this computer.'
    }
  }
  if (kind === 'ollama') {
    return {
      tone: 'info',
      text:
        `Ollama runs on this computer, so the transcripts and typed notes it gets ${TITLES} ` +
        'stay on this computer.'
    }
  }
  const check = kind === 'unknown' ? ' Test tells you whether it’s Ollama.' : ''
  return {
    tone: 'warning',
    text:
      `Sends the session’s transcript to the server at ${host} on this computer ${TITLES}. Lyra ` +
      'can’t see where that server sends it: a proxy can forward it to a hosted model. Audio, ' +
      `voiceprints and typed notes stay in Lyra.${check}`
  }
}
