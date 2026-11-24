import { z } from 'zod'

/**
 * The cloud model providers summaries can use, through the AI SDK. One list for main (which
 * builds the model) and the renderer (which shows the choices).
 */
export const ProviderId = z.enum(['anthropic', 'openai', 'google', 'openai-compatible'])
export type ProviderId = z.infer<typeof ProviderId>

export type ProviderInfo = {
  label: string
  /** The model used when Settings names none; null when the user must pick one. */
  defaultModel: string | null
  /** The environment variable the provider's own SDKs read for a key, if there is one. */
  keyEnv: string | null
  /** A key is optional only for local servers (Ollama, LM Studio, llama.cpp). */
  needsKey: boolean
  /** Only a self-hosted, OpenAI-compatible server needs an address. */
  needsBaseUrl: boolean
  /** Where to get a key, for the Settings hint. */
  keyHelp: string
}

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-opus-5-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    needsKey: true,
    needsBaseUrl: false,
    keyHelp: 'From console.anthropic.com.'
  },
  openai: {
    label: 'OpenAI',
    defaultModel: null,
    keyEnv: 'OPENAI_API_KEY',
    needsKey: true,
    needsBaseUrl: false,
    keyHelp: 'From platform.openai.com.'
  },
  google: {
    label: 'Google',
    defaultModel: null,
    keyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    needsKey: true,
    needsBaseUrl: false,
    keyHelp: 'From aistudio.google.com.'
  },
  'openai-compatible': {
    label: 'OpenAI-compatible server',
    defaultModel: null,
    keyEnv: null,
    needsKey: false,
    needsBaseUrl: true,
    keyHelp: 'Only if your server asks for one.'
  }
} as const satisfies Record<ProviderId, ProviderInfo>

/** A model id as providers and gateways spell them (`claude-opus-5-5`, `llama3.1:8b`, `models/x`). */
export const ModelId = z
  .string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z0-9][\w.:@/-]*$/)

/** Where a key comes from: saved in Settings (the system keychain), or the environment. */
export const KeySource = z.enum(['keychain', 'environment'])
export type KeySource = z.infer<typeof KeySource>
