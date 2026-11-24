import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * Every environment variable the app reads, as one zod schema. `config.ts` parses the
 * environment with it at startup, and `scripts/config-docs.mjs` writes docs/CONFIG.md from each
 * field's metadata, so the code and the docs cannot drift.
 *
 * Names follow an existing standard where there is one (the AI SDK providers' `*_API_KEY` and
 * `*_BASE_URL`, the Hugging Face hub's `HF_ENDPOINT`), so a machine already set up for those
 * tools works as is. Only settings that mean nothing outside Lyra take the `LYRA_` prefix.
 *
 * Imports only `node:path` and `zod`: the docs script loads it with Node's type stripping.
 */

export type EnvDoc = {
  kind: 'path' | 'url' | 'secret'
  /** One or two sentences for docs/CONFIG.md. */
  description: string
  /** What applies when it's unset, in words. */
  fallback: string
}

/** An empty value means the same as unset. */
const unset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const path = (doc: Omit<EnvDoc, 'kind'>) =>
  z
    .preprocess(unset, z.string().trim().refine(isAbsolute, 'must be an absolute path').optional())
    .meta({ kind: 'path', ...doc })

const url = (doc: Omit<EnvDoc, 'kind'>) =>
  z
    .preprocess(
      unset,
      z
        .url({ protocol: /^https?$/, error: 'must be an http or https URL' })
        .transform((value) => value.replace(/\/+$/, ''))
        .optional()
    )
    .meta({ kind: 'url', ...doc })

const secret = (doc: Omit<EnvDoc, 'kind'>) =>
  z.preprocess(unset, z.string().trim().optional()).meta({ kind: 'secret', ...doc })

const KEY_NOTE =
  'Used when no key is saved in Settings; a saved key wins. Having a key never sends anything: summaries use a cloud model only when the user picks one.'

export const EnvVars = z.object({
  LYRA_NOTES_DIR: path({
    description: 'Notes folder a new profile starts with. Once settings are saved, the saved folder is used.',
    fallback: '`~/.lyra`'
  }),
  LYRA_MODELS_DIR: path({
    description:
      'Where downloaded models are kept. Point smoke tests and evals at one folder to download each model once.',
    fallback: '`<userData>/models`'
  }),
  HF_ENDPOINT: url({
    description:
      'Hugging Face mirror to download models from (the same variable the Hugging Face tools read). Files are still checked against their pinned sha256.',
    fallback: '`https://huggingface.co`'
  }),
  ANTHROPIC_API_KEY: secret({ description: `Anthropic API key. ${KEY_NOTE}`, fallback: 'the key saved in Settings, if any' }),
  ANTHROPIC_BASE_URL: url({
    description: 'Anthropic API endpoint, for a proxy or gateway. Include the version path, as the AI SDK expects (`https://gateway.example/v1`).',
    fallback: '`https://api.anthropic.com/v1`'
  }),
  OPENAI_API_KEY: secret({ description: `OpenAI API key. ${KEY_NOTE}`, fallback: 'the key saved in Settings, if any' }),
  OPENAI_BASE_URL: url({
    description: 'OpenAI API endpoint, for a proxy or gateway.',
    fallback: '`https://api.openai.com/v1`'
  }),
  GOOGLE_GENERATIVE_AI_API_KEY: secret({
    description: `Google Gemini API key. ${KEY_NOTE}`,
    fallback: 'the key saved in Settings, if any'
  }),
  ELECTRON_RENDERER_URL: url({
    description: 'Set by `electron-vite dev` to the dev server. Read only in development builds.',
    fallback: 'the bundled renderer'
  })
})

export type EnvName = keyof typeof EnvVars.shape
