import { promptAppFits, type PromptApp } from '../../../shared/promptApps'
import { DEFAULT_SEND_PARTS, SEND_PART_LABEL, sendText, sessionParts, type SendPart } from '../../../shared/sendParts'
import type { OpenPage } from '../hooks/usePages'
import { AppIcon, sendToPromptApp } from '../hooks/usePromptApps'
import { useSettings } from '../hooks/useSettings'
import { CheckIcon } from './Icons'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from './ui/dropdown-menu'

type Props = { session: OpenPage; apps: readonly PromptApp[] }

/**
 * A session's "Send to…" page: which parts to include (kept in settings, so the next session
 * starts from the same choice), then the installed apps. Ticking a part keeps the menu open.
 */
export function SendToMenu({ session, apps }: Props) {
  const { settings, update } = useSettings()
  const chosen = settings?.sendToParts ?? DEFAULT_SEND_PARTS
  const parts = sessionParts(session).map(({ part }) => part)
  const included = parts.filter((part) => chosen.includes(part))
  const text = sendText(session, included)
  const toggle = (part: SendPart, on: boolean): void => {
    const next = on ? [...chosen.filter((p) => p !== part), part] : chosen.filter((p) => p !== part)
    void update({ sendToParts: next })
  }
  return (
    <>
      <DropdownMenuLabel>Include</DropdownMenuLabel>
      {parts.map((part) => (
        <DropdownMenuCheckboxItem
          key={part}
          checked={included.includes(part)}
          onCheckedChange={(on) => toggle(part, on)}
          onSelect={(event) => event.preventDefault()}
        >
          <span className="grid size-4 place-items-center" aria-hidden="true">
            {included.includes(part) ? <CheckIcon /> : null}
          </span>
          <span className="min-w-0 flex-1 truncate">{SEND_PART_LABEL[part]}</span>
        </DropdownMenuCheckboxItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Send to</DropdownMenuLabel>
      {apps.map((app) => {
        const fits = promptAppFits(app.id, text)
        return (
          <DropdownMenuItem
            key={app.id}
            disabled={!fits || included.length === 0}
            onSelect={() => sendToPromptApp(app, text)}
          >
            <span className="grid size-4 place-items-center" aria-hidden="true">
              <AppIcon app={app} />
            </span>
            <span className="min-w-0 flex-1 truncate">{app.name}</span>
            {fits ? null : <span className="ml-auto pl-4 text-[11px] text-text-3">Too long</span>}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
