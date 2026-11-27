import { useEffect, useState } from 'react'
import { promptAppFits, type PromptApp } from '../../../shared/promptApps'
import type { MenuItem } from '../components/ContextMenu'
import { SendIcon } from '../components/Icons'
import { notify } from '../lib/toast'

/**
 * The coding and chat apps installed here that open with a prompt filled in, asked again when
 * the window regains focus (the person may have just installed one). Empty until known.
 */
export function usePromptApps(): PromptApp[] {
  const [apps, setApps] = useState<PromptApp[]>([])
  useEffect(() => {
    let alive = true
    const check = (): void => {
      window.api.promptApps().then(
        (next) => {
          if (alive) setApps(next)
        },
        () => {
          // Unknown is shown as none: the menus just don't offer them.
        }
      )
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [])
  return apps
}

/** Opens `app` with `text` as its prompt; the person sends it from there. */
export function sendToPromptApp(app: PromptApp, text: string): void {
  window.api.openInPromptApp({ app: app.id, text }).then(
    ({ truncated }) => {
      notify(truncated ? `Too long for ${app.name}: sent the start of it` : `Opened in ${app.name}`)
    },
    () => {
      notify(`Couldn’t open ${app.name}.`)
    }
  )
}

/** Something a menu can send: what it's called there, and the text. */
export type PromptPayload = { label: string; text: string }

/**
 * "Send to…": choosing it turns the menu into the installed prompt apps, each with its icon.
 * With several payloads (just the notes, or the transcript too) the apps are listed under a
 * heading for each. A payload too long for an app is shown but not offered. None without apps.
 */
export function sendToItems(
  apps: readonly PromptApp[],
  payloads: readonly PromptPayload[],
  open: (app: PromptApp, text: string) => void = sendToPromptApp
): MenuItem[] {
  if (!apps.length || !payloads.length) return []
  const leaf = (app: PromptApp, text: string): MenuItem => {
    const fits = promptAppFits(app.id, text)
    return {
      label: fits ? app.name : `${app.name} (too long)`,
      icon: <AppIcon app={app} />,
      disabled: !fits,
      run: () => open(app, text)
    }
  }
  const grouped = payloads.length > 1
  const items = payloads.flatMap((payload): MenuItem[] => [
    ...(grouped ? [{ heading: payload.label }] : []),
    ...apps.map((app) => leaf(app, payload.text))
  ])
  return [{ label: 'Send to…', icon: <SendIcon />, next: { label: 'Send to', items } }]
}

/** The app's own icon from the OS, or its initial where the OS gives none. */
export function AppIcon({ app }: { app: PromptApp }) {
  return app.icon ? (
    <img src={app.icon} alt="" className="size-4" draggable={false} />
  ) : (
    <span className="grid size-4 place-items-center rounded-sm bg-muted text-[10px] font-semibold">
      {app.name.charAt(0)}
    </span>
  )
}
