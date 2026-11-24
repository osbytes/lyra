/**
 * Every environment variable the app reads, in one table. `config.ts` parses them at startup and
 * `scripts/config-docs.mjs` writes docs/CONFIG.md from this table, so the two cannot drift.
 *
 * Names follow an existing standard where there is one (the Anthropic SDK's `ANTHROPIC_*`, the
 * Hugging Face hub's `HF_ENDPOINT`), so a machine already set up for those tools works as is.
 * Only settings that mean nothing outside Lyra take the `LYRA_` prefix.
 *
 * This file has no imports: the docs script loads it with Node's type stripping.
 */

export type EnvKind = 'path' | 'url' | 'string' | 'secret'

export type EnvVar = {
  name: string
  kind: EnvKind
  /** One or two sentences for docs/CONFIG.md. */
  description: string
  /** What applies when it's unset, in words. */
  fallback: string
}

export const ENV_VARS = [
  {
    name: 'LYRA_NOTES_DIR',
    kind: 'path',
    description:
      'Notes folder a new profile starts with. Once settings are saved, the saved folder is used.',
    fallback: '`~/.lyra`'
  },
  {
    name: 'LYRA_MODELS_DIR',
    kind: 'path',
    description:
      'Where downloaded models are kept. Point smoke tests and evals at one folder to download each model once.',
    fallback: '`<userData>/models`'
  },
  {
    name: 'HF_ENDPOINT',
    kind: 'url',
    description:
      'Hugging Face mirror to download models from (the same variable the Hugging Face tools read). Files are still checked against their pinned sha256.',
    fallback: '`https://huggingface.co`'
  },
  {
    name: 'ANTHROPIC_API_KEY',
    kind: 'secret',
    description:
      'Claude API key used when none is saved in Settings. Summaries still only go to Claude when the user turns on Claude summaries.',
    fallback: 'the key saved in the system keychain, if any'
  },
  {
    name: 'ANTHROPIC_BASE_URL',
    kind: 'url',
    description: 'Claude API endpoint, for a proxy or gateway.',
    fallback: "the Anthropic SDK's default (`https://api.anthropic.com`)"
  },
  {
    name: 'ANTHROPIC_MODEL',
    kind: 'string',
    description:
      'Claude model for summaries and titles when none is chosen in Settings. A model picked in Settings wins.',
    fallback: 'the model Lyra ships with (`claude-opus-5-5`)'
  },
  {
    name: 'ELECTRON_RENDERER_URL',
    kind: 'url',
    description: 'Set by `electron-vite dev` to the dev server. Read only in development builds.',
    fallback: 'the bundled renderer'
  }
] as const satisfies readonly EnvVar[]

export type EnvName = (typeof ENV_VARS)[number]['name']
