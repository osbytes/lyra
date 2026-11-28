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
import { clear as clearActivity, end as endActivity, report as reportActivity } from '../activity'

/** A labeled meeting, as the speaker pipeline would leave it, for reviewing the transcript UI. */
async function seedScreenshotMeeting(): Promise<string> {
  const meeting = await createPage({ startedAt: '2026-11-23T10:30:00' })
  const sam = await addPerson('Sam', [0.1, 0.2, 0.3], false)
  const alex = await addPerson('Alex', [0.3, 0.2, 0.1], false)
  await editSession(meeting.id, (doc) => {
    addTag(doc, 'design')
    addTag(doc, 'team')
    editDoc(doc, {
      title: 'Design review',
      summary:
        'Summary\nAgreed to ship the dock redesign first, then settings.\n\nSections\n- 0:00 The dock: what people see first\n- 0:15 Shortcuts and the meeting button\n- 0:31 First run and support\n\nAction items\n- [ ] Dana: port tokens into styles.css\n- [ ] Sam: check contrast in dark mode'
    })
    upsertSpeaker(doc, 'c0', { name: 'Dana', personId: null, confirmed: true, confidence: 0.96, matches: [] })
    upsertSpeaker(doc, 'c1', {
      name: 'Sam',
      personId: sam.id,
      confirmed: false,
      confidence: 0.71,
      matches: [{ personId: sam.id, score: 0.71 }, { personId: alex.id, score: 0.38 }]
    })
    upsertSpeaker(doc, 'c2', { name: 'Speaker 3', personId: null, confirmed: false, confidence: null, matches: [] })
    replaceTranscript(doc, [
      { id: 's0', rawId: 's0', start: 2, end: 7, cluster: 'c0', confidence: 0.97, text: 'I think the dock is the thing people see first, so let’s start there.' },
      { id: 's1', rawId: 's1', start: 9, end: 14, cluster: 'c1', confidence: 0.81, text: 'Agreed. I can check the contrast numbers in dark mode this afternoon.' },
      { id: 's2', rawId: 's2', start: 15, end: 21, cluster: 'c2', confidence: null, text: 'Does the meeting button need its own shortcut in the dock, or is the hotkey enough?' },
      { id: 's3', rawId: 's3', start: 22, end: 27, cluster: 'c0', confidence: 0.95, text: 'Show the shortcut on hover. One primary action, one secondary.' },
      { id: 's4', rawId: 's4', start: 31, end: 38, cluster: 'c1', confidence: 0.52, text: 'From the support side, people mostly ask where their recordings went.' },
      { id: 's5', rawId: 's5', start: 40, end: 45, cluster: 'c1', confidence: 0.78, text: 'Then the folder chip on first run should help with that.' }
    ])
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
  for (let open = 0; open < 3 && (await run(`!!document.querySelector('.picker-layer, [data-slot="dropdown-menu-content"]')`)); open++) {
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
 * Review shots of the window grid: the session at full, wide, medium (library as a drawer, panes
 * stacked) and compact width (one column with tabs), and the transcript split dragged. Puts the
 * window back afterwards.
 */
async function reviewLayouts(
  win: BrowserWindow,
  theme: 'light' | 'dark',
  dir: string,
  save: (dir: string, name: string) => Promise<void>,
  settle: () => Promise<void>
): Promise<void> {
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  const [width, height] = win.getContentSize()
  const resize = async (next: number): Promise<void> => {
    win.setContentSize(next, height ?? 800)
    await settle()
  }
  // The speaker picker and context menu from the shots before may still be open over the page.
  for (let open = 0; open < 3 && (await run(`!!document.querySelector('.picker-layer')`)); open++) {
    await run(`document.querySelector('.picker-layer')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await settle()
  }
  const steps: string[] = []
  const layout = (): Promise<unknown> =>
    run(`JSON.stringify({
      width: window.innerWidth,
      sidebar: Math.round(document.querySelector('.app > .sidebar')?.getBoundingClientRect().width ?? 0),
      panes: document.querySelectorAll('.workspace-column .scroller').length,
      split: document.querySelector('[role="separator"]')?.getAttribute('aria-orientation') ?? null
    })`)

  await resize(1440)
  steps.push(`full: ${String(await layout())}`)
  await save(dir, `layout-full-${theme}.png`)
  await resize(1100)
  steps.push(`wide: ${String(await layout())}`)
  await save(dir, `layout-wide-${theme}.png`)
  // Drag the split to give the transcript more room.
  const handle = (await run(
    `(() => { const r = document.querySelector('.split-handle')?.getBoundingClientRect(); return r ? [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] : null })()`
  )) as [number, number] | null
  if (handle) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: handle[0], y: handle[1], button: 'left', clickCount: 1 })
    for (let step = 1; step <= 6; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: handle[0] + step * 20, y: handle[1], button: 'left', modifiers: ['leftbuttondown'] })
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: handle[0] + 120, y: handle[1], button: 'left', clickCount: 1 })
    await settle()
    steps.push(`split dragged: ${String(await run(`document.querySelector('.split-handle')?.getAttribute('aria-valuenow')`))}`)
  }
  await resize(760)
  steps.push(`medium: ${String(await layout())}`)
  await save(dir, `layout-medium-${theme}.png`)
  await run(`document.querySelector('.sidebar-toggle')?.click()`)
  await settle()
  await save(dir, `layout-drawer-${theme}.png`)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await run(`document.querySelector('.library-drawer')?.parentElement?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await settle()
  await resize(400)
  steps.push(`compact: ${String(await layout())}`)
  await save(dir, `layout-compact-${theme}.png`)
  await run(`[...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Summary')?.click()`)
  await settle()
  await save(dir, `layout-compact-summary-${theme}.png`)
  await run(`[...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Transcript')?.click()`)
  process.stdout.write(`layouts (${theme}):\n  ${steps.join('\n  ')}\n`)
  win.setContentSize(width ?? 1280, height ?? 800)
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
        // Home: the dashboard, with no session open.
        await click('.home-link')
        await settle()
        await save(reviewDir, `home-${theme}.png`)
        // People under Home: the list, then the first person's page.
        await click('.people-link')
        await settle()
        await save(reviewDir, `people-${theme}.png`)
        await click('.people-page li button')
        await settle()
        await save(reviewDir, `person-${theme}.png`)
        await reload()
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
            `document.querySelector('.transcript-pane .scroller')?.scrollTo({ top: 1e6 })`
          )
          await settle()
          await save(reviewDir, `processing-${theme}.png`)
          win.webContents.send('meeting:status', { ...busy, state: 'done', progress: 1 })
        }
        // Activity: a download still going and a failed summary, in the status bar and its panel.
        if (meetingId) {
          reportActivity({
            id: 'model:semanticSearch',
            kind: 'model',
            origin: 'settings',
            title: 'Downloading the search model',
            detail: '63 of 150 MB',
            progress: 0.42,
            actions: ['cancel']
          })
          endActivity(
            {
              id: `notes:${meetingId}`,
              kind: 'notes',
              origin: 'session',
              pageId: meetingId,
              title: "Couldn't write the summary",
              detail: "The model didn't answer within 5 minutes.",
              actions: ['open', 'retry']
            },
            'failed'
          )
          // Past the 3 s a running task waits before it joins Activity.
          await new Promise((done) => setTimeout(done, 3200))
          await settle()
          await save(reviewDir, `activity-${theme}.png`)
          await click('.activity-button')
          await settle()
          await save(reviewDir, `activity-popover-${theme}.png`)
          await win.webContents.executeJavaScript(
            `document.querySelector('.picker-layer')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`
          )
          clearActivity('model:semanticSearch')
          clearActivity(`notes:${meetingId}`)
          await settle()
        }
        await reviewTranscriptEditing(win, theme, reviewDir, save, settle)
        // Naming starts from the summary pane's speaker list.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.speaker-row')].find((b) => b.textContent.includes('Sam'))?.click()`
        )
        await settle()
        await save(reviewDir, `picker-${theme}.png`)
        await reviewLayouts(win, theme, reviewDir, save, settle)
      }
      // An open themed select, in Preferences.
      nativeTheme.themeSource = 'light'
      await reload()
      await pressShortcut(',')
      await settle()
      await click('.settings-main .select')
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
          const box = document.querySelector('.sidebar-footer [data-slot="button"]')?.getBoundingClientRect()
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
