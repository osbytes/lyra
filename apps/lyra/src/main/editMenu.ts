import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * The right-click menu for text fields (title, notes, search, settings inputs): spelling fixes,
 * undo and the clipboard. Electron shows none by default. Everything else in the window uses
 * the renderer's own context menus, which call preventDefault so this never opens over them.
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
      { role: 'selectAll', enabled: editFlags.canSelectAll }
    ]).popup({ window: win })
  })
}
