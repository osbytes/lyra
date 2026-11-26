/** `lyra screenshot`: the README screenshot and, with --review, every UI state in both themes. */
import { app, nativeTheme, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSession as createPage,
  editSession,
  saveSessionPage as savePage
} from '../sessionStore'
import { editDoc, replaceTranscript, addTag, upsertSpeaker } from '../../shared/sessionDoc'
import { addPerson } from '../voices'
import { log } from '../log'
import type { MeetingStatus } from '../../shared/types'

/** A labeled meeting, as the speaker pipeline would leave it, for reviewing the transcript UI. */
async function seedScreenshotMeeting(): Promise<string> {
  const meeting = await createPage({ startedAt: '2026-11-23T10:30:00' })
  const sam = await addPerson('Sam', [0.1, 0.2, 0.3], false)
  const alex = await addPerson('Alex', [0.3, 0.2, 0.1], false)
  await editSession(meeting.id, (doc) => {
    doc.transact(() => {
      addTag(doc, 'design', 'seed')
      addTag(doc, 'team', 'seed')
      editDoc(doc, {
        title: 'Design review',
        summary:
          'Summary\nAgreed to ship the dock redesign first, then settings.\n\nAction items\n- [ ] Dana: port tokens into styles.css\n- [ ] Sam: check contrast in dark mode'
      }, 'seed')
      upsertSpeaker(doc, 'c0', { name: 'Dana', personId: null, confirmed: true, confidence: 0.96, matches: [] }, 'seed')
      upsertSpeaker(doc, 'c1', {
        name: 'Sam',
        personId: sam.id,
        confirmed: false,
        confidence: 0.71,
        matches: [{ personId: sam.id, score: 0.71 }, { personId: alex.id, score: 0.38 }]
      }, 'seed')
      upsertSpeaker(doc, 'c2', { name: 'Speaker 3', personId: null, confirmed: false, confidence: null, matches: [] }, 'seed')
      replaceTranscript(doc, [
        { id: 's0', rawId: 's0', start: 2, end: 7, cluster: 'c0', confidence: 0.97, text: 'I think the dock is the thing people see first, so let’s start there.' },
        { id: 's1', rawId: 's1', start: 9, end: 14, cluster: 'c1', confidence: 0.81, text: 'Agreed. I can check the contrast numbers in dark mode this afternoon.' },
        { id: 's2', rawId: 's2', start: 15, end: 21, cluster: 'c2', confidence: null, text: 'Does the meeting button need its own shortcut in the dock, or is the hotkey enough?' },
        { id: 's3', rawId: 's3', start: 22, end: 27, cluster: 'c0', confidence: 0.95, text: 'Show the shortcut on hover. One primary action, one secondary.' },
        { id: 's4', rawId: 's4', start: 31, end: 38, cluster: 'c1', confidence: 0.52, text: 'From the support side, people mostly ask where their recordings went.' },
        { id: 's5', rawId: 's5', start: 40, end: 45, cluster: 'c1', confidence: 0.78, text: 'Then the folder chip on first run should help with that.' }
      ], 'seed')
    }, 'seed')
  })
  return meeting.id
}

/** Seeds the sample pages; resolves to the meeting's id when one was seeded. */
async function seedScreenshotPages(withMeeting: boolean): Promise<string | null> {
  const meetingId = withMeeting ? await seedScreenshotMeeting() : null
  const team = await createPage()
  await savePage({
    id: team.id,
    title: 'Team sync notes',
    body:
      'Quick recap from this morning.\n\n' +
      'Keep the first-run flow simple: one page, one record button. ' +
      'Ship sidebar delete before we rename the app in the UI.'
  })

  const journal = await createPage()
  await savePage({
    id: journal.id,
    title: 'Morning journal',
    body:
      'Woke up thinking about how nice it is to talk ideas out without sending audio anywhere. ' +
      'Maybe the default view should always open the latest page.'
  })

  const ideas = await createPage()
  await savePage({
    id: ideas.id,
    title: 'Product ideas',
    body:
      'Lyra should feel like a notebook, not a chatbot.\n\n' +
      'A few things worth trying next:\n' +
      '- Rename pages inline from the sidebar\n' +
      '- Keyboard shortcut for record / stop\n' +
      '- Export a page as plain text or markdown\n\n' +
      'The core loop is already good: open a page, talk, edit, copy, come back later.'
  })
  return meetingId
}

/**
 * Review shots of the locked transcript: the selection toolbar, a correction, a removal and a
 * highlight, the right-click menu, and Ctrl+Z taking the edits back one by one.
 */
async function reviewTranscriptEditing(
  win: BrowserWindow,
  theme: 'light' | 'dark',
  dir: string,
  save: (dir: string, name: string) => Promise<void>,
  settle: () => Promise<void>
): Promise<void> {
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  // Selects `words` inside line `id` the way a drag would.
  const select = (id: string, words: string): Promise<unknown> =>
    run(`(() => {
      const piece = [...document.querySelectorAll('[data-line="${id}"] [data-kind="raw"]')]
        .find((el) => el.textContent.includes(${JSON.stringify(words)}))
      const node = piece?.firstChild
      if (!node) return false
      const start = node.textContent.indexOf(${JSON.stringify(words)})
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + ${String(words.length)})
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    })()`)
  const bar = (label: string): Promise<unknown> =>
    run(`[...document.querySelectorAll('.selection-bar button')].find((b) => b.textContent === ${JSON.stringify(label)})?.click()`)
  const lineText = (id: string): Promise<unknown> =>
    run(`(() => {
      const line = document.querySelector('[data-line="${id}"]')?.cloneNode(true)
      line?.querySelectorAll('del').forEach((el) => el.remove())
      const marks = [...(document.querySelector('[data-line="${id}"]')?.querySelectorAll('ins, del, .hl') ?? [])]
      return line ? line.textContent + ' [' + marks.map((el) => el.tagName === 'SPAN' ? 'hl' : el.tagName.toLowerCase()).join(',') + ']' : null
    })()`)
  const undoKey = (): Promise<unknown> =>
    run(`document.querySelector('.lines').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, metaKey: true, bubbles: true }))`)

  if (!(await select('s1', 'contrast numbers'))) throw new Error('could not select words')
  await settle()
  await save(dir, `transcript-select-${theme}.png`)
  await bar('Highlight')
  await settle()
  await select('s1', ' this afternoon')
  await settle()
  await bar('Remove')
  await settle()
  await select('s0', 'dock')
  await settle()
  await bar('Correct')
  await settle()
  await run(`(() => {
    const input = document.querySelector('.correct-pop input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'dark mode')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await save(dir, `transcript-correct-${theme}.png`)
  await run(`document.querySelector('.correct-pop').requestSubmit()`)
  await settle()
  await save(dir, `transcript-edited-${theme}.png`)
  const box = (await run(
    `(() => { const r = document.querySelector('[data-line="s4"]').getBoundingClientRect(); return [r.left + 40, r.top + 8] })()`
  )) as [number, number]
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box[0], y: box[1], button: 'right', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box[0], y: box[1], button: 'right', clickCount: 1 })
  await settle()
  await save(dir, `transcript-menu-${theme}.png`)
  for (let open = 0; open < 3 && (await run(`!!document.querySelector('.picker-layer, .menu-layer')`)); open++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 600, y: 20, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 600, y: 20, button: 'left', clickCount: 1 })
    await settle()
  }
  const steps = [String(await lineText('s0')), String(await lineText('s1'))]
  for (let i = 0; i < 3; i++) {
    await undoKey()
    await settle()
    steps.push(`${String(await lineText('s0'))} / ${String(await lineText('s1'))}`)
  }
  process.stdout.write(`transcript undo (${theme}):\n  ${steps.join('\n  ')}\n`)
}

/**
 * Review shots of dragging the layout's edges with the details panel open: both side panels
 * widened to their maximum, then each dragged past its breakpoint to close, and the transcript
 * bar dragged to the top to close the notes. Puts the layout back afterwards.
 */
async function reviewPanelResizing(
  win: BrowserWindow,
  theme: 'light' | 'dark',
  dir: string,
  save: (dir: string, name: string) => Promise<void>,
  settle: () => Promise<void>
): Promise<void> {
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  const center = async (selector: string): Promise<[number, number]> => {
    const point = await run(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null })()`
    )
    if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') {
      throw new Error(`nothing to drag at ${selector}`)
    }
    return [point[0], point[1]]
  }
  const drag = async (selector: string, to: (from: [number, number]) => [number, number]): Promise<void> => {
    const from = await center(selector)
    const [x, y] = to(from)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: from[0], y: from[1], button: 'left', clickCount: 1 })
    for (let step = 1; step <= 8; step++) {
      const at = (a: number, b: number): number => Math.round(a + ((b - a) * step) / 8)
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: at(from[0], x),
        y: at(from[1], y),
        button: 'left',
        modifiers: ['leftbuttondown']
      })
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await settle()
  }
  const layout = (): Promise<unknown> =>
    run(`JSON.stringify({
      sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0,
      details: document.querySelector('.details')?.getBoundingClientRect().width ?? 0,
      notes: !!document.querySelector('.notes-pane:not(.is-collapsed)')
    })`)
  const steps: string[] = []
  // The speaker picker and context menu from the shots before are still open over the page.
  for (let open = 0; open < 3 && (await run(`!!document.querySelector('.picker-layer, .menu-layer')`)); open++) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 600, y: 20, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 600, y: 20, button: 'left', clickCount: 1 })
    await settle()
  }

  await drag('.panel-resizer.is-left', ([x, y]) => [x + 600, y])
  await drag('.panel-resizer.is-right', ([x, y]) => [x - 600, y])
  steps.push(`widened: ${String(await layout())}`)
  await save(dir, `resize-wide-${theme}.png`)
  await drag('.panel-resizer.is-left', ([, y]) => [40, y])
  await drag('.panel-resizer.is-right', ([x, y]) => [x + 400, y])
  steps.push(`closed: ${String(await layout())}`)
  await drag('.transcript-bar', ([x]) => [x, 60])
  steps.push(`bar at top: ${String(await layout())}`)
  await save(dir, `resize-closed-${theme}.png`)
  // The closed sidebar's edge waits at the window's edge; dragging it out opens it again.
  await drag('.panel-resizer.is-left', ([x, y]) => [x + 200, y])
  steps.push(`sidebar dragged open: ${String(await layout())}`)
  process.stdout.write(`panel resizing (${theme}):\n  ${steps.join('\n  ')}\n`)

  await run(
    `window.api.updateSettings({ sidebar: true, sidebarWidth: 256, detailsPanel: true, detailsWidth: 288 })`
  )
  await run(`document.querySelector('.transcript-bar-tools button[aria-label="Show notes"]')?.click()`)
  await settle()
}

export async function captureScreenshot(win: BrowserWindow, reviewDir: string | null): Promise<void> {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600))
  const reload = async (): Promise<void> => {
    const reloaded = new Promise<void>((resolve) => {
      win.webContents.once('did-finish-load', () => resolve())
    })
    win.webContents.reload()
    await reloaded
    await settle()
  }
  const save = async (dir: string, name: string): Promise<void> => {
    const image = await win.webContents.capturePage()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), image.toPNG())
    process.stdout.write(`screenshot: ${join(dir, name)}\n`)
  }
  const pressShortcut = (key: string): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, metaKey: true }))`
    )
  const click = (selector: string): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click()`
    )

  try {
    // --review captures every state in both themes for UI review; without it, only the README
    // shot is written.
    if (reviewDir) {
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await save(reviewDir, `empty-${theme}.png`)
      }
    }
    const meetingId = await seedScreenshotPages(reviewDir !== null)
    nativeTheme.themeSource = 'light'
    await reload()
    // out/main → the repository's docs/ folder, which the README links to.
    await save(join(__dirname, '../../../../docs'), 'screenshot.png')
    if (reviewDir) {
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await save(reviewDir, `page-${theme}.png`)
        await pressShortcut('k')
        await settle()
        await save(reviewDir, `search-recent-${theme}.png`)
        // A typo, to show fuzzy matching reaching the transcript.
        await win.webContents.insertText('contrst')
        await settle()
        await save(reviewDir, `search-${theme}.png`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        await settle()
        await save(reviewDir, `search-open-${theme}.png`)
        await reload()
        await pressShortcut(',')
        await settle()
        await save(reviewDir, `settings-${theme}.png`)
        // The tabs after General, in nav order.
        for (const [index, tab] of ['sessions', 'people', 'performance', 'about'].entries()) {
          await click(`.settings-nav button:nth-of-type(${String(index + 2)})`)
          await settle()
          if (tab === 'performance') {
            // The graphs appear once the first 5-second sample is in; then show the hover readout.
            await win.webContents.executeJavaScript(`new Promise((resolve) => {
              const poll = () => document.querySelector('.usage-chart-plot') ? resolve() : setTimeout(poll, 250)
              poll()
            })`)
            await win.webContents.executeJavaScript(
              `document.querySelector('.usage-chart-plot')?.focus()`
            )
            await settle()
          }
          await save(reviewDir, `settings-${tab}-${theme}.png`)
          if (tab === 'sessions') {
            // Cloud summaries: provider, model and key rows (no key in a throwaway profile).
            await win.webContents.executeJavaScript(
              `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Cloud model')?.click()`
            )
            await settle()
            await win.webContents.executeJavaScript(
              `document.querySelector('[aria-label="Model"]')?.scrollIntoView({ block: 'center' })`
            )
            await settle()
            await save(reviewDir, `settings-cloud-${theme}.png`)
            await win.webContents.executeJavaScript(
              `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Off')?.click()`
            )
            await settle()
            // Prompts, with a few apps on the "Don't ask" list.
            await win.webContents.executeJavaScript(`(async () => {
              const settings = await window.api.getSettings()
              await window.api.updateSettings({ micPrompt: { ...settings.micPrompt, ignoredApps: ['Discord', 'obs64', 'Google Meet'] } })
            })()`)
            await settle()
            await win.webContents.executeJavaScript(
              `document.querySelector('[aria-label="App to never ask about"]')?.scrollIntoView({ block: 'center' })`
            )
            await settle()
            await save(reviewDir, `settings-prompts-${theme}.png`)
          }
        }
      }
      // The labeled meeting: transcript, then the speaker picker on a guessed speaker.
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        // By title: editing the meeting moves it to the top of the list.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.page-item')].find((el) => el.textContent.includes('Design review'))?.click()`
        )
        await settle()
        await win.webContents.executeJavaScript(`document.querySelector('.transcript')?.scrollIntoView()`)
        await settle()
        await save(reviewDir, `meeting-${theme}.png`)
        // Still processing, scrolled to the end: the status stays in view in the toast stack, with
        // the time left, and the sidebar marks the session.
        if (meetingId) {
          const busy: MeetingStatus = {
            pageId: meetingId,
            task: 'speakers',
            state: 'diarizing',
            progress: 0,
            estimate: { startedAt: Date.now() - 40_000, expectedMs: 160_000 }
          }
          win.webContents.send('meeting:status', busy)
          await win.webContents.executeJavaScript(
            `document.querySelector('.transcript-pane')?.scrollTo({ top: 1e6 })`
          )
          await settle()
          await save(reviewDir, `processing-${theme}.png`)
          win.webContents.send('meeting:status', { ...busy, state: 'done', progress: 1 })
        }
        // The transcript bar's layouts: collapsed to the bar, then the transcript alone.
        const pane = async (label: string): Promise<void> => {
          await click(`.transcript-bar-tools button[aria-label="${label}"]`)
          await settle()
        }
        await pane('Collapse transcript')
        await save(reviewDir, `transcript-collapsed-${theme}.png`)
        await pane('Show transcript')
        await pane('Expand transcript')
        await save(reviewDir, `transcript-expanded-${theme}.png`)
        await pane('Show notes')
        await reviewTranscriptEditing(win, theme, reviewDir, save, settle)
        await click('.speaker-chip.likely')
        await settle()
        await save(reviewDir, `picker-${theme}.png`)
        // The same session in the side-panel layout.
        await pressShortcut('.')
        await settle()
        await save(reviewDir, `panel-${theme}.png`)
        await reviewPanelResizing(win, theme, reviewDir, save, settle)
        await pressShortcut('.')
        await settle()
      }
      // What the session records, and an open themed select.
      nativeTheme.themeSource = 'light'
      await reload()
      await click('.dock-sources')
      await settle()
      await save(reviewDir, 'sources-light.png')
      await click('.picker.sources .select')
      await settle()
      await save(reviewDir, 'select-light.png')
      // A session's right-click menu, and a tooltip.
      for (const theme of ['light', 'dark'] as const) {
        nativeTheme.themeSource = theme
        await reload()
        await win.webContents.executeJavaScript(`(() => {
          const row = document.querySelector('.page-row')
          const box = row?.getBoundingClientRect()
          row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: (box?.left ?? 0) + 60, clientY: (box?.top ?? 0) + 20 }))
        })()`)
        await settle()
        await save(reviewDir, `menu-${theme}.png`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        await settle()
        const point: unknown = await win.webContents.executeJavaScript(`(() => {
          const box = document.querySelector('.sidebar-footer .ghost-btn')?.getBoundingClientRect()
          return box ? [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)] : [0, 0]
        })()`)
        const [x = 0, y = 0] = Array.isArray(point) ? point.map(Number) : []
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await new Promise((resolve) => setTimeout(resolve, 900))
        await save(reviewDir, `tooltip-${theme}.png`)
      }
      // Deleting asks first, then shows the Undo toast; Ctrl+Z brings the session back.
      nativeTheme.themeSource = 'light'
      await reload()
      await click('.page-row:last-child .page-delete')
      await settle()
      await save(reviewDir, 'confirm-delete-light.png')
      await click('.confirm .btn.primary')
      await settle()
      await save(reviewDir, 'undo-delete-light.png')
      await pressShortcut('z')
      await settle()
      await save(reviewDir, 'undid-delete-light.png')
      // A title too long for one line wraps within the page's text column.
      await win.webContents.executeJavaScript(`(() => {
        const field = document.querySelector('.title-input')
        if (!field) return
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
          field,
          'Quarterly planning with design, research and support: roadmap, hiring and launch dates'
        )
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await settle()
      await save(reviewDir, 'title-wrap-light.png')
    }
    app.exit(0)
  } catch (error) {
    log('screenshot', 'failed', error)
    app.exit(1)
  }
}
