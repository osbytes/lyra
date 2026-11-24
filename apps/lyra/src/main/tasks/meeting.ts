/** `lyra meeting`: the real speaker pipeline on a WAV, for smoke:meeting, evals and replays. */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesDir } from '../pages'
import {
  createSession as createPage,
  flushAllSessions,
  readSession,
  sessionRawDir
} from '../sessionStore'
import { overrideSettings } from '../settings'
import { assignSpeaker, processMeeting } from '../meeting/pipeline'
import { listPeople } from '../voices'
import type { Services } from '../services'
import { replayRecording } from '../meeting/replay'
import { relabeled } from '../meeting/relabel'
import { trackPath } from '../recorder'
import { log } from '../log'
import type { Task } from './args'

type MeetingTask = Extract<Task, { kind: 'meeting' }>

/**
 * Dev check: runs the real speaker pipeline (models, diarization, Whisper) on a
 * 16 kHz mono WAV and prints the labeled note. `pnpm smoke:meeting <file.wav>`
 */
export async function runMeetingFixture(task: MeetingTask, services: Services): Promise<void> {
  const wavPath = task.mic
  try {
    const page = await createPage()
    // Optional second track, to exercise the mic-vs-system "Me" labeling.
    const systemFixture = task.system
    const started = Date.now()
    // `live` (the default) replays the audio as a recording; `offline` labels it after the fact.
    if (task.pipeline === 'offline') {
      const micPath = trackPath(page.id, 'mic')
      await mkdir(join(micPath, '..'), { recursive: true })
      await copyFile(wavPath, micPath)
      const systemPath = systemFixture ? trackPath(page.id, 'system') : null
      if (systemFixture && systemPath) await copyFile(systemFixture, systemPath)
      await processMeeting({ pageId: page.id, micPath, systemPath, seconds: 0 })
    } else {
      await replayRecording(page.id, wavPath, systemFixture)
      await relabeled(page.id)
    }
    await flushAllSessions()
    const exported = await readFile(join(notesDir(), page.id), 'utf8')
    const took = ((Date.now() - started) / 1000).toFixed(1)
    process.stdout.write(`meeting-fixture (${took} s):\n${exported}\n`)
    const labeled = await readSession(page.id)
    const confidence = labeled.transcript.map((segment) =>
      segment.confidence === null ? '-' : segment.confidence.toFixed(2)
    )
    process.stdout.write(`meeting-fixture line confidence: ${confidence.join(' ')}\n`)
    // Evals (scripts/run-eval.cjs) score this pass, before the rename below changes any labels.
    const output = task.output
    if (output) {
      const segments = labeled.transcript.map(({ start, end, cluster, text }) => ({
        speaker: cluster ?? 'unknown',
        start,
        end,
        text
      }))
      // The live pass's decisions too, so a bad result can be traced to the phrase that caused it.
      const livePath = join(sessionRawDir(page.id), 'live.json')
      const live: unknown = existsSync(livePath) ? JSON.parse(await readFile(livePath, 'utf8')) : null
      const trace = live && typeof live === 'object' && 'trace' in live ? live.trace : []
      await writeFile(output, JSON.stringify({ seconds: +took, segments, trace }, null, 2), 'utf8')
    }

    // Name the first speaker and save their voice, as the speaker picker does.
    const first = labeled.speakers[0]
    if (!first) {
      // One voice: the session stays notes, so there's nothing to name.
      process.stdout.write('meeting-fixture: one voice, kept as notes\n')
      app.exit(0)
      return
    }
    await assignSpeaker(page.id, first.id, { name: 'Fixture Person', remember: true })
    await flushAllSessions()
    const renamed = await readFile(join(notesDir(), page.id), 'utf8')
    const people = await listPeople()
    if (!renamed.includes('] Fixture Person: ') || people.length !== 1) {
      throw new Error('naming did not update the export or save the voice')
    }
    process.stdout.write('meeting-fixture: relabel ok\n')

    // Optional: --notes local|claude also writes meeting notes.
    const engine = task.notes
    if (engine) {
      overrideSettings({ notesEngine: engine })
      const notesStarted = Date.now()
      await services.notes.generateNotes(page.id)
      const withNotes = await readSession(page.id)
      const notesTook = ((Date.now() - notesStarted) / 1000).toFixed(1)
      process.stdout.write(`meeting-fixture notes (${engine}, ${notesTook} s):\n${withNotes.summary}\n`)
      // The recording ended before the engine was turned on, so ask for the title here.
      const before = withNotes.title
      const titleStarted = Date.now()
      await services.titles.suggestTitle(page.id)
      const titled = (await readSession(page.id)).title
      const titleTook = ((Date.now() - titleStarted) / 1000).toFixed(1)
      process.stdout.write(`meeting-fixture title (${engine}, ${titleTook} s): "${before}" -> "${titled}"\n`)
    }
    app.exit(0)
  } catch (error) {
    log('meeting-fixture', 'failed', error)
    app.exit(1)
  }
}
