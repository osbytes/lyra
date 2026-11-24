import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Services } from '../services'
import { overrideSettings } from '../settings'
import { isTaskName, parseTask, type Task } from './args'
import { runMeetingFixture } from './meeting'
import { captureScreenshot } from './screenshot'
import { runUiSmoke } from './smoke'

/** The temp profile folder a task run uses; the launch scripts delete it afterwards. */
export const TASK_PROFILE_PREFIX = 'lyra-task-'

/** The task on this launch's command line: after the executable, and after `.` in development. */
export function taskFromArgv(): Task | null {
  return parseTask(process.argv.slice(app.isPackaged ? 1 : 2))
}

/** Whether the command line names a task, even one whose options failed to parse. */
export function isTaskLaunch(): boolean {
  return process.argv.slice(app.isPackaged ? 1 : 2).some(isTaskName)
}

/** Points the app at a throwaway profile before anything reads userData or settings. */
export function prepareTaskProfile(task: Task): void {
  app.setPath('userData', join(tmpdir(), `${TASK_PROFILE_PREFIX}${String(process.pid)}`))
  overrideSettings({ notesDir: join(app.getPath('userData'), 'notes') })
  if (task.kind === 'smoke') {
    // A pre-0.2 page in the old location, for the migration check.
    const legacy = join(app.getPath('userData'), 'pages')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(
      join(legacy, 'legacy-smoke.md'),
      '---\nid: legacy-smoke\ntitle: "Legacy page"\nupdatedAt: 2025-01-01T00:00:00.000Z\n---\n\nold body'
    )
  }
}

/** Runs `task` once the main window has loaded; each task exits the app with its result. */
export function runTaskIn(win: BrowserWindow, task: Task, services: Services): void {
  if (task.kind === 'screenshot') win.setContentSize(1280, 800)
  win.webContents.once('did-finish-load', () => {
    switch (task.kind) {
      case 'smoke':
        void runUiSmoke(win)
        return
      case 'screenshot':
        void captureScreenshot(win, task.reviewDir)
        return
      case 'meeting':
        void runMeetingFixture(task, services)
        return
    }
  })
}
