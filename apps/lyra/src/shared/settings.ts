import { z } from 'zod'
import { ModelId, ProviderId } from './ai'
import { TranscriptionLanguage } from './languages'
import { Vocabulary } from './vocabulary'

/** Both formats are always readable; this one is used for new notes. */
export const NoteFormat = z.enum(['txt', 'md'])
export type NoteFormat = z.infer<typeof NoteFormat>

/** Windows (`C:\…`, `\\server\…`) or POSIX. Checked here because the renderer has no `node:path`. */
const AbsolutePath = z
  .string()
  .trim()
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, 'must be an absolute path')

/** Whether `raw` is a URL on this computer: `localhost`, `127.0.0.0/8` or `::1`. */
export function isLoopbackUrl(raw: string): boolean {
  let hostname: string
  try {
    hostname = new URL(raw).hostname.toLowerCase()
  } catch {
    return false
  }
  // The URL parser has already normalised `127.1` and `0x7f.0.0.1` to dotted decimal.
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname)
}

/**
 * An OpenAI-compatible server's address. Transcripts go to it, so plain `http` is only allowed
 * when it never leaves this computer.
 */
const ServerUrl = z
  .url({ protocol: /^https?$/ })
  .refine(
    (url) => url.toLowerCase().startsWith('https:') || isLoopbackUrl(url),
    'must be https unless the server is on this computer'
  )

/**
 * How wide the side panels can be dragged, in pixels. Dragging past `closeBelow` closes the
 * panel instead, so the range between it and `min` is where the edge snaps.
 */
export const PANEL_WIDTHS = {
  sidebar: { min: 200, max: 420, initial: 256, closeBelow: 140 },
  details: { min: 240, max: 520, initial: 288, closeBelow: 160 }
} as const

/** User settings, stored in `userData/settings.json`. The one definition: the type comes from it. */
export const SettingsSchema = z.object({
  /** Folder that holds the notes. Default `~/.lyra`, or LYRA_NOTES_DIR. */
  notesDir: AbsolutePath,
  fileFormat: NoteFormat,
  /** `null` = the system default microphone. */
  micDeviceId: z.string().nullable(),
  /** Electron accelerator for the global start/stop shortcut. */
  hotkey: z.string(),
  launchAtLogin: z.boolean(),
  /** Any app taking the mic offers a session. `ignoredApps` holds names the user said "Don't ask" for. */
  micPrompt: z.object({ enabled: z.boolean(), ignoredApps: z.array(z.string()) }),
  /** A meeting (Zoom, Teams, Meet in a browser, …) taking the mic offers to record it. */
  meetingPrompt: z.boolean(),
  /**
   * Days to keep recorded audio after a session: `null` keeps it forever, `0` deletes it once the
   * transcript is labeled. Transcripts are always kept.
   */
  audioRetentionDays: z.int().min(0).max(3650).nullable(),
  captureSystemAudio: z.boolean(),
  /** What Whisper transcribes: a language code, or `auto` to detect it per chunk. */
  transcriptionLanguage: TranscriptionLanguage,
  /**
   * Names and jargon to spell the user's way: put in front of Whisper's prompt for each chunk.
   * Trimmed, without duplicates, at most 100 terms of 60 characters.
   */
  vocabulary: Vocabulary,
  /** Summaries and titles: off, a model on this computer, or a cloud model the user chose. */
  notesEngine: z.enum(['off', 'local', 'cloud']),
  cloudProvider: ProviderId,
  /** `null` uses the provider's default model, where it has one. */
  cloudModel: ModelId.nullable(),
  /** Address of an OpenAI-compatible server (Ollama, LM Studio, …), e.g. `http://localhost:11434/v1`. */
  cloudBaseUrl: ServerUrl.nullable(),
  /** Show a session's details (dates, tags, speakers) in a side panel instead of inline. */
  detailsPanel: z.boolean(),
  /** Show the session list on the left. */
  sidebar: z.boolean(),
  sidebarWidth: z.int().min(PANEL_WIDTHS.sidebar.min).max(PANEL_WIDTHS.sidebar.max),
  detailsWidth: z.int().min(PANEL_WIDTHS.details.min).max(PANEL_WIDTHS.details.max),
  /** The one-time "get consent before recording others" notice was acknowledged. */
  meetingNoticeSeen: z.boolean(),
  /** Search by meaning as well as by words, with a model on this computer (~146 MB). */
  semanticSearch: z.boolean()
})
export type Settings = z.infer<typeof SettingsSchema>

/** Older settings files, rewritten to today's fields before they're checked. */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw }
  // Before retention days there was "Keep meeting audio"; on means keep forever.
  if (!('audioRetentionDays' in raw) && raw.keepMeetingAudio === true) out.audioRetentionDays = null
  // Lyra 0.3 had Claude as its only cloud engine.
  if (raw.notesEngine === 'claude') {
    out.notesEngine = 'cloud'
    out.cloudProvider = 'anthropic'
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `input` layered over `base`, keeping only what the schema accepts: a malformed or unknown field
 * falls back to `base`'s value, so a hand-edited or older file never stops Lyra from starting.
 */
export function parseSettings(input: unknown, base: Settings): Settings {
  const merged = { ...base, ...(isRecord(input) ? migrate(input) : {}) }
  const first = SettingsSchema.safeParse(merged)
  if (first.success) return first.data
  const bad = new Set(first.error.issues.map((issue) => issue.path[0]))
  const fallback: Record<string, unknown> = base
  const repaired = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [key, bad.has(key) ? fallback[key] : value])
  )
  return SettingsSchema.parse(repaired)
}
