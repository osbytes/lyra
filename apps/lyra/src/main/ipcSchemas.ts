import { z } from 'zod'
import { SettingsSchema, type Settings } from '../shared/settings'

/**
 * The arguments renderer windows send over IPC, one schema per channel. Pure (no Electron), so
 * the unit tests check them directly. Paths are never taken from here: page ids are file names,
 * resolved later by `resolveInNotes()`, and the notes folder is chosen in main.
 */

/** A page id is a file name; no file system allows one longer than 255. */
export const PageIdArg = z.string().min(1).max(255)

/** `pages:save`. The body is a whole note, so the cap only stops a runaway renderer. */
export const SavePageArg = z.object({
  id: PageIdArg,
  title: z.string().max(10_000),
  body: z.string().max(20_000_000)
})

/** A Yjs update from a window; a whole document's state fits well inside this. */
export const MAX_SESSION_UPDATE_BYTES = 64 * 1024 * 1024
export const SessionUpdateArg = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength > 0, 'empty update')
  .refine((bytes) => bytes.byteLength <= MAX_SESSION_UPDATE_BYTES, 'update too large')

/** `pages:create`. An unparseable `startedAt` falls back to now in `createSession`. */
export const CreatePageArg = z
  .object({ startedAt: z.string().max(64).optional() })
  .optional()
  .transform((options) => (options?.startedAt === undefined ? {} : { startedAt: options.startedAt }))

const field = SettingsSchema.shape

/**
 * Only known fields, each with the same check as settings.json. Spelled out (rather than
 * `.partial()`) so an absent field is absent, never `undefined`, as `Partial<Settings>` means
 * under `exactOptionalPropertyTypes`.
 */
const SettingsPatchSchema = z
  .object({
    notesDir: field.notesDir.exactOptional(),
    fileFormat: field.fileFormat.exactOptional(),
    micDeviceId: field.micDeviceId.exactOptional(),
    hotkey: field.hotkey.exactOptional(),
    launchAtLogin: field.launchAtLogin.exactOptional(),
    micPrompt: field.micPrompt.exactOptional(),
    meetingPrompt: field.meetingPrompt.exactOptional(),
    audioRetentionDays: field.audioRetentionDays.exactOptional(),
    captureSystemAudio: field.captureSystemAudio.exactOptional(),
    transcriptionLanguage: field.transcriptionLanguage.exactOptional(),
    vocabulary: field.vocabulary.exactOptional(),
    notesEngine: field.notesEngine.exactOptional(),
    cloudProvider: field.cloudProvider.exactOptional(),
    cloudModel: field.cloudModel.exactOptional(),
    cloudBaseUrl: field.cloudBaseUrl.exactOptional(),
    detailsPanel: field.detailsPanel.exactOptional(),
    sidebar: field.sidebar.exactOptional(),
    sidebarWidth: field.sidebarWidth.exactOptional(),
    detailsWidth: field.detailsWidth.exactOptional(),
    meetingNoticeSeen: field.meetingNoticeSeen.exactOptional(),
    semanticSearch: field.semanticSearch.exactOptional(),
    largerSpeakerModel: field.largerSpeakerModel.exactOptional()
  })
  .strict()

/** Every setting, by name: a setting added to SettingsSchema but not above fails to compile. */
export const SETTINGS_PATCH_FIELDS: Record<keyof Settings, unknown> = SettingsPatchSchema.shape

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

/**
 * A `settings:update` patch. Unknown fields or a non-object throw. A field whose value fails its
 * check is dropped, as a bad field in settings.json falls back on its own, so one bad value
 * doesn't lose the rest. `notesDir` is refused unless `allowNotesDir` (task runs): in the app the
 * folder is only changed by main, after the user picks one in the native dialog.
 */
export function parseSettingsPatch(
  raw: unknown,
  options: { allowNotesDir: boolean }
): { patch: Partial<Settings>; dropped: string[] } {
  const keys = z.partialRecord(SettingsSchema.keyof(), z.unknown()).parse(raw)
  if ('notesDir' in keys && !options.allowNotesDir) {
    throw new Error('The sessions folder is changed with pickFolder, not updateSettings')
  }
  const first = SettingsPatchSchema.safeParse(keys)
  if (first.success) return { patch: first.data, dropped: [] }
  const bad = new Set(first.error.issues.map((issue) => String(issue.path[0])))
  const kept = Object.fromEntries(Object.entries(keys).filter(([key]) => !bad.has(key)))
  return { patch: SettingsPatchSchema.parse(kept), dropped: [...bad] }
}

/** `retention:preview`: a "Keep audio" value, checked as the setting itself is. */
export const RetentionDaysArg = field.audioRetentionDays

/**
 * `notes:listModels`: a server address, checked as the setting is (https unless on this
 * computer), so the model list is never asked of an address Settings would refuse to save.
 */
export const ServerUrlArg = field.cloudBaseUrl.unwrap()

/**
 * `models:cancel`: a model file name. Only a download already running under that name is
 * stopped (`cancelModelDownload` looks it up), so any other name does nothing.
 */
export const ModelNameArg = z
  .string()
  .max(200)
  .regex(/^[\w][\w.-]*$/, 'not a model file name')

/** `models:retry`: which feature's model to fetch again. */
export const ModelFeatureArg = z.enum(['semanticSearch', 'localNotes'])

/** `permissions:openSettings`. Main maps each to a fixed system settings page. */
export const PermissionKindArg = z.enum(['microphone', 'screen'])

/** `diagnostics:reveal`. Main maps each to a fixed folder. */
export const RevealTargetArg = z.enum(['logs', 'models'])
