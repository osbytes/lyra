import { z } from 'zod'
import { ModelId, ProviderId } from './ai'
import { TranscriptionLanguage } from './languages'

/** Both formats are always readable; this one is used for new notes. */
export const NoteFormat = z.enum(['txt', 'md'])
export type NoteFormat = z.infer<typeof NoteFormat>

/** Windows (`C:\…`, `\\server\…`) or POSIX. Checked here because the renderer has no `node:path`. */
const AbsolutePath = z
  .string()
  .trim()
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, 'must be an absolute path')

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
  micPrompt: z.object({ enabled: z.boolean(), ignoredApps: z.array(z.string()) }),
  /**
   * Days to keep recorded audio after a session: `null` keeps it forever, `0` deletes it once the
   * transcript is labeled. Transcripts are always kept.
   */
  audioRetentionDays: z.int().min(0).max(3650).nullable(),
  captureSystemAudio: z.boolean(),
  /** What Whisper transcribes: a language code, or `auto` to detect it per chunk. */
  transcriptionLanguage: TranscriptionLanguage,
  /** Summaries and titles: off, a model on this computer, or a cloud model the user chose. */
  notesEngine: z.enum(['off', 'local', 'cloud']),
  cloudProvider: ProviderId,
  /** `null` uses the provider's default model, where it has one. */
  cloudModel: ModelId.nullable(),
  /** Address of an OpenAI-compatible server (Ollama, LM Studio, …), e.g. `http://localhost:11434/v1`. */
  cloudBaseUrl: z.url({ protocol: /^https?$/ }).nullable(),
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
