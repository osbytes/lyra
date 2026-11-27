import { z } from 'zod'

/**
 * Coding and chat apps that open with a prompt typed in from a link. Every one of these only
 * fills in the prompt: nothing is sent until the person presses Enter in that app. Apps whose
 * links can't carry a prompt yet (opencode 2, Ollama, Windsurf, Raycast AI) are left out
 * rather than opened empty.
 */
export const PROMPT_APP_IDS = [
  'claude',
  'claude-code',
  'claude-desktop-code',
  'chatgpt',
  'cursor',
  'zed',
  'copilot',
  't3code'
] as const

export const PromptAppId = z.enum(PROMPT_APP_IDS)
export type PromptAppId = z.infer<typeof PromptAppId>

export const PromptAppRequest = z.object({ app: PromptAppId, text: z.string() })
export type PromptAppRequest = z.infer<typeof PromptAppRequest>

/** An installed app; `icon` is its OS icon as a PNG data URL, null where the OS gives none. */
export type PromptApp = { id: PromptAppId; name: string; icon: string | null }

type Spec = {
  name: string
  /** The scheme the app registers with the OS; a handler for it means the app is installed. */
  scheme: string
  /** The link that opens a new chat with `prompt` (already URL-encoded) in the composer. */
  link: (prompt: string) => string
  /** The most text the app takes from a link. */
  limit: number
}

// Claude Code documents a 5,000 character cap and Claude Desktop about 14,000; the others
// document none, so they get a cap that keeps the link within what every OS passes along.
const SPECS: Record<PromptAppId, Spec> = {
  claude: {
    name: 'Claude',
    scheme: 'claude',
    link: (prompt) => `claude://claude.ai/new?q=${prompt}`,
    limit: 5000
  },
  'claude-code': {
    name: 'Claude Code',
    scheme: 'claude-cli',
    link: (prompt) => `claude-cli://open?q=${prompt}`,
    limit: 5000
  },
  // Claude Desktop's own Code tab, apart from the terminal one above.
  'claude-desktop-code': {
    name: 'Claude Code (Desktop)',
    scheme: 'claude',
    link: (prompt) => `claude://code/new?q=${prompt}`,
    limit: 5000
  },
  // The ChatGPT desktop app kept Codex's scheme.
  chatgpt: {
    name: 'ChatGPT',
    scheme: 'codex',
    link: (prompt) => `codex://new?prompt=${prompt}`,
    limit: 4000
  },
  cursor: {
    name: 'Cursor',
    scheme: 'cursor',
    link: (prompt) => `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`,
    limit: 4000
  },
  zed: {
    name: 'Zed',
    scheme: 'zed',
    link: (prompt) => `zed://agent?prompt=${prompt}`,
    limit: 4000
  },
  // Without a repo, the app opens a new session with none chosen, after asking.
  copilot: {
    name: 'GitHub Copilot',
    scheme: 'ghapp',
    link: (prompt) => `ghapp://session/new?prompt=${prompt}`,
    limit: 4000
  },
  t3code: {
    name: 'T3 Code',
    scheme: 't3code',
    link: (prompt) => `t3code://new?prompt=${prompt}`,
    limit: 4000
  }
}

const normalize = (text: string): string => text.replace(/\r\n?/g, '\n').trim()

/** Whether `text` goes to `id` whole, without being cut to its limit. */
export const promptAppFits = (id: PromptAppId, text: string): boolean =>
  normalize(text).length <= SPECS[id].limit

export const promptAppName = (id: PromptAppId): string => SPECS[id].name

/** What the OS is asked about to see whether the app is installed (`scheme://`). */
export const promptAppProbe = (id: PromptAppId): string => `${SPECS[id].scheme}://`

/**
 * The link that opens `id` with `text` as its prompt. Text past the app's limit is cut at the
 * last word that fits; `truncated` says so, so the window can tell the person.
 */
export function promptAppLink(id: PromptAppId, text: string): { url: string; truncated: boolean } {
  const spec = SPECS[id]
  const clean = normalize(text)
  if (clean.length <= spec.limit) return { url: spec.link(encodeURIComponent(clean)), truncated: false }
  // Never end on half an emoji: encodeURIComponent throws on a lone surrogate.
  const end = /[\uD800-\uDBFF]/.test(clean.charAt(spec.limit - 1)) ? spec.limit - 1 : spec.limit
  const cut = clean.slice(0, end)
  const space = cut.search(/\s\S*$/)
  const kept = (space > spec.limit / 2 ? cut.slice(0, space) : cut).trimEnd()
  return { url: spec.link(encodeURIComponent(kept)), truncated: true }
}
