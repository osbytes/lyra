import { type z } from 'zod'
import type { ProviderId } from '../shared/ai'
import { EnvVars, type EnvName } from './envSpec'

const HF_DEFAULT = 'https://huggingface.co'

/**
 * The environment, parsed once at startup with the schema in `envSpec.ts`. Nothing else in the
 * main process reads `process.env` (lint enforces it); it asks `config()`. A value that is set but
 * wrong stops the app with a message naming the variable, rather than being ignored.
 */
const ConfigSchema = EnvVars.transform((env) => ({
  notesDir: env.LYRA_NOTES_DIR ?? null,
  modelsDir: env.LYRA_MODELS_DIR ?? null,
  /** No trailing slash. */
  hfEndpoint: env.HF_ENDPOINT ?? HF_DEFAULT,
  /** Keys and endpoints by provider, as the providers' own SDKs name them. */
  apiKeys: {
    anthropic: env.ANTHROPIC_API_KEY ?? null,
    openai: env.OPENAI_API_KEY ?? null,
    google: env.GOOGLE_GENERATIVE_AI_API_KEY ?? null,
    'openai-compatible': null
  } satisfies Record<ProviderId, string | null>,
  baseUrls: {
    anthropic: env.ANTHROPIC_BASE_URL ?? null,
    openai: env.OPENAI_BASE_URL ?? null
  },
  rendererUrl: env.ELECTRON_RENDERER_URL ?? null
}))

export type Config = z.output<typeof ConfigSchema>

export class ConfigError extends Error {
  override name = 'ConfigError'
}


/** Parses `env`; throws ConfigError naming each variable that is set but malformed. */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = ConfigSchema.safeParse(env)
  if (result.success) return result.data
  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? 'environment')
    return `${name} ${issue.message} (got "${env[name] ?? ''}")`
  })
  throw new ConfigError(problems.join('; '))
}

let current: Config | null = null

/** The parsed environment. Throws ConfigError on a bad value; startup checks this first. */
export function config(): Config {
  current ??= parseConfig(process.env)
  return current
}

/** Parses the environment up front, so a bad value is reported before anything else runs. */
export function checkConfig(): ConfigError | null {
  try {
    config()
    return null
  } catch (error) {
    if (error instanceof ConfigError) return error
    throw error
  }
}

/** Which variables are set, without their values, for the startup log line. */
export function configSummary(): EnvName[] {
  const names = Object.keys(EnvVars.shape).filter((name): name is EnvName => name in EnvVars.shape)
  return names.filter((name) => (process.env[name]?.trim() ?? '') !== '')
}

/** `url` with the Hugging Face host swapped for HF_ENDPOINT, so a mirror serves every model. */
export function hubUrl(url: string): string {
  const { hfEndpoint } = config()
  return hfEndpoint !== HF_DEFAULT && url.startsWith(`${HF_DEFAULT}/`)
    ? `${hfEndpoint}${url.slice(HF_DEFAULT.length)}`
    : url
}
