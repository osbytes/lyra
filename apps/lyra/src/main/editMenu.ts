import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { promptAppFits } from '../shared/promptApps'
import { log } from './log'
import { installedPromptApps, openInPromptApp } from './promptApps'

/**
 * The right-click menu for text fields (title, notes, search, settings inputs): spelling fixes,
 * undo, the clipboard, and opening the selection in an installed coding or chat app (as a
 * prompt the person still sends themselves). Electron shows none by default. Everything else in
 * the window uses the renderer's own context menus, which call preventDefault so this never
 * opens over them.
 */
export function attachEditMenu(win: BrowserWindow): void {
  const contents = win.webContents
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return
    const { editFlags, misspelledWord, dictionarySuggestions } = params
    const modifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'
    // Undo goes through the window's own key handling, so it uses the session's history
    // (the title and transcript) rather than the text box's.
    const press = (shift: boolean): void => {
      const modifiers: ('meta' | 'control' | 'shift')[] = shift ? [modifier, 'shift'] : [modifier]
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers })
    }

    const spelling: MenuItemConstructorOptions[] = misspelledWord
      ? [
          ...dictionarySuggestions.slice(0, 5).map((word) => ({
            label: word,
            click: () => {
              contents.replaceMisspelling(word)
            }
          })),
          ...(dictionarySuggestions.length ? [] : [{ label: 'No suggestions', enabled: false }]),
          {
            label: 'Add to dictionary',
            click: () => {
              contents.session.addWordToSpellCheckerDictionary(misspelledWord)
            }
          },
          { type: 'separator' }
        ]
      : []

    void sendToItems(params.selectionText.trim()).then((sendTo) => {
      Menu.buildFromTemplate([
        ...spelling,
        // Always on: the text box can't see the session's history, so its flags would be wrong.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => press(false) },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => press(true) },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
        ...sendTo
      ]).popup({ window: win })
    })
  })
}

/** "Send to ▸", listing the installed prompt apps with their icons; nothing without a selection. */
async function sendToItems(selected: string): Promise<MenuItemConstructorOptions[]> {
  const apps = selected ? await installedPromptApps() : []
  if (!apps.length) return []
  const submenu = apps.map(({ id, name, image }): MenuItemConstructorOptions => {
    const fits = promptAppFits(id, selected)
    return {
      label: fits ? name : `${name} (too long)`,
      enabled: fits,
      ...(image ? { icon: image.resize({ width: 16, height: 16 }) } : {}),
      click: () => {
        openInPromptApp({ app: id, text: selected }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          log('promptApps', 'open failed', { app: id, error: message })
        })
      }
    }
  })
  return [{ type: 'separator' }, { label: 'Send to', submenu }]
}
