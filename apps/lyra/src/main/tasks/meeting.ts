/** `lyra meeting`: the real speaker pipeline on a WAV, for smoke:meeting, evals and replays. */
import { app } from 'electron'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesDir } from '../pages'
import { createSession as createPage, flushAllSessions, readSession } from '../sessionStore'
import { overrideSettings } from '../settings'
import { assignSpeaker, processMeeting } from '../meeting/pipeline'
import { addPerson, listPeople } from '../voices'
import { embedVoice, ensureSpeakerModels } from '../meeting/speakers'
import { readWav } from '../meeting/wav'
import type { Services } from '../services'
import { replayRecording } from '../meeting/replay'
import { labelStability } from '../meeting/labelChanges'
import { liveWords, relabeled } from '../meeting/relabel'
import { onRecordingFinished, recordingPageId, trackPath } from '../recorder'
import { toggleSession } from '../session'
import { log } from '../log'
import { transcribeWithParakeet } from '../parakeet'
import { transcribePcm, warmUp } from '../whisper'
import type { Task } from './args'

type MeetingTask = Extract<Task, { kind: 'meeting' }>

/** Settles once `check` is true, looking every 50 ms. */
async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Records `wavPath` the way a user records a session: the window's real start (the session
 * command the hotkey sends), getUserMedia on Chromium's fake microphone playing the file
 * (`prepareTaskProfile`), the capture graph and worklet, and the recorder. Whisper is loaded first
 * so the window starts listening at once; the fake device plays from when the mic opens, so the
 * timeline can start a few frames late. Returns the session's id once the recording has stopped.
 */
async function captureThroughWindow(wavPath: string): Promise<string> {
  await warmUp()
  const seconds = (await readWav(wavPath)).length / 16000
  const finished = new Promise<string>((resolve) => {
    const off = onRecordingFinished((recording) => {
      off()
      resolve(recording.pageId)
    })
  })
  toggleSession()
  await until(() => recordingPageId() !== null, 30_000, 'the window to start recording')
  // Real time: the file plays as it would from a microphone, then a moment for the last chunk.
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 1500))
  toggleSession()
  return finished
}

/**
 * Dev check: runs the real speaker pipeline (models, diarization, Whisper) on a
 * 16 kHz mono WAV and prints the labeled note. `pnpm smoke:meeting <file.wav>`
 */
export async function runMeetingFixture(task: MeetingTask, services: Services): Promise<void> {
  const wavPath = task.mic
  try {
    const page = task.capture ? { id: await captureThroughWindow(wavPath) } : await createPage()
    if (task.enroll) {
      const models = await ensureSpeakerModels()
      await addPerson('Enrolled', await embedVoice(await readWav(task.enroll), models), true)
    }
    // Optional second track, to exercise the mic-vs-system "Me" labeling.
    const systemFixture = task.system
    const started = Date.now()
    // `live` (the default) replays the audio as a recording; `offline` labels it after the fact.
    if (task.capture) {
      await relabeled(page.id)
    } else if (task.pipeline === 'offline') {
      const micPath = trackPath(page.id, 'mic')
      await mkdir(join(micPath, '..'), { recursive: true })
      await copyFile(wavPath, micPath)
      const systemPath = systemFixture ? trackPath(page.id, 'system') : null
      if (systemFixture && systemPath) await copyFile(systemFixture, systemPath)
      await processMeeting({ pageId: page.id, micPath, systemPath, seconds: 0 })
    } else {
      const transcribe = task.asr === 'parakeet' ? transcribeWithParakeet : transcribePcm
      await replayRecording(page.id, wavPath, systemFixture, { transcribe, carryContext: task.context })
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
      const labels = labelStability(page.id)
      // The words as transcribed, with their times: the scorer uses them to tell words given to
      // the wrong speaker by diarization from words whose times put them in the wrong turn.
      const words = (await liveWords(page.id)).map(({ text, start, end, track }) => ({ text, start, end, track }))
      await writeFile(output, JSON.stringify({ seconds: +took, labels, segments, words }, null, 2), 'utf8')
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
    // Voiceprints come from settling the speakers after the recording; without that step the
    // speakers are only the tracks they were heard on, with no voice to save.
    const saved = (task.enroll ? 1 : 0) + (task.relabel || task.pipeline === 'offline' ? 1 : 0)
    if (!renamed.includes('] Fixture Person: ') || people.length !== saved) {
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
