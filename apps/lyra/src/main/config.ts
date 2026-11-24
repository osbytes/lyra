import { isAbsolute } from 'node:path'
import { ENV_VARS, type EnvName } from './envSpec'

/**
 * The environment, parsed once at startup. Nothing else in the main process reads `process.env`;
 * it asks `config()`. A value that is set but wrong stops the app with a message naming the
 * variable, rather than being ignored. Unset and empty mean the same thing.
 */
export type Config = {
  notesDir: string | null
  modelsDir: string | null
  /** No trailing slash. */
  hfEndpoint: string
  anthropicApiKey: string | null
  anthropicBaseUrl: string | null
  anthropicModel: string | null
  rendererUrl: string | null
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const HF_DEFAULT = 'https://huggingface.co'

type Env = Readonly<Record<string, string | undefined>>

function read(env: Env, name: EnvName): string | null {
  const value = env[name]?.trim()
  return value ? value : null
}

function path(env: Env, name: EnvName): string | null {
  const value = read(env, name)
  if (value !== null && !isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path (got "${value}")`)
  }
  return value
}

function url(env: Env, name: EnvName): string | null {
  const value = read(env, name)
  if (value === null) return null
  let protocol: string
  try {
    protocol = new URL(value).protocol
  } catch {
    throw new ConfigError(`${name} must be a URL (got "${value}")`)
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new ConfigError(`${name} must be an http or https URL (got "${value}")`)
  }
  return value.replace(/\/+$/, '')
}

export function parseConfig(env: Env): Config {
  return {
    notesDir: path(env, 'LYRA_NOTES_DIR'),
    modelsDir: path(env, 'LYRA_MODELS_DIR'),
    hfEndpoint: url(env, 'HF_ENDPOINT') ?? HF_DEFAULT,
    anthropicApiKey: read(env, 'ANTHROPIC_API_KEY'),
    anthropicBaseUrl: url(env, 'ANTHROPIC_BASE_URL'),
    anthropicModel: read(env, 'ANTHROPIC_MODEL'),
    rendererUrl: url(env, 'ELECTRON_RENDERER_URL')
  }
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
export function configSummary(): string[] {
  return ENV_VARS.flatMap((spec) => (read(process.env, spec.name) === null ? [] : [spec.name]))
}

/** `url` with the Hugging Face host swapped for HF_ENDPOINT, so a mirror serves every model. */
export function hubUrl(url: string): string {
  const { hfEndpoint } = config()
  return hfEndpoint !== HF_DEFAULT && url.startsWith(`${HF_DEFAULT}/`)
    ? `${hfEndpoint}${url.slice(HF_DEFAULT.length)}`
    : url
}
