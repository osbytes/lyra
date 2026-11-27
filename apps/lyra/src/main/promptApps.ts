import { app, shell, type NativeImage } from 'electron'
import {
  PROMPT_APP_IDS,
  promptAppLink,
  promptAppName,
  promptAppProbe,
  type PromptApp,
  type PromptAppId,
  type PromptAppRequest
} from '../shared/promptApps'
import { log } from './log'

/** Menu icons are drawn at 16 px; twice that keeps them sharp on a 2x display. */
const ICON_SIZE = 32

/** Each app's icon, by the handler it came from: reading one from the OS is slowish. */
const icons = new Map<PromptAppId, { handler: string; image: NativeImage | null }>()

/**
 * The app's own icon, as the OS shows it. Windows and macOS only; elsewhere, and when the
 * handler is a script with no icon of its own, there's none and the menu shows the name alone.
 */
async function iconOf(id: PromptAppId, handler: string): Promise<NativeImage | null> {
  const known = icons.get(id)
  if (known?.handler === handler) return known.image
  let image: NativeImage | null = null
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const info = await app.getApplicationInfoForProtocol(promptAppProbe(id))
      image = info.icon.isEmpty() ? null : info.icon.resize({ width: ICON_SIZE, height: ICON_SIZE })
    } catch (error) {
      log('promptApps', 'no icon', { app: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  icons.set(id, { handler, image })
  return image
}

/**
 * The prompt apps installed here (the ones the OS has a handler for), with their icons. Asked
 * each time, since it's a quick registry or Launch Services lookup and apps come and go.
 */
export async function installedPromptApps(): Promise<(PromptApp & { image: NativeImage | null })[]> {
  const found = PROMPT_APP_IDS.map((id) => ({ id, handler: app.getApplicationNameForProtocol(promptAppProbe(id)) }))
  return Promise.all(
    found
      .filter(({ handler }) => handler !== '')
      .map(async ({ id, handler }) => {
        const image = await iconOf(id, handler)
        return { id, name: promptAppName(id), icon: image?.toDataURL() ?? null, image }
      })
  )
}

/**
 * Opens an app with `text` as its prompt. Only on the person's click: this hands note text to
 * another app, which fills it in and waits for them to send it.
 */
export async function openInPromptApp({ app: id, text }: PromptAppRequest): Promise<{ truncated: boolean }> {
  const { url, truncated } = promptAppLink(id, text)
  log('promptApps', 'open', { app: id, chars: text.length, truncated })
  await shell.openExternal(url)
  return { truncated }
}
