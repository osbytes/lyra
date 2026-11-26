import { SAMPLE_RATE } from '../../shared/audio/vad'
import { recorderFixture, type TranscribeExperiment } from '../recorder'
import { liveLabelsIdle } from './liveLabels'
import { readWav } from './wav'

/**
 * Replays recorded audio through what a live recording runs, without a window or a microphone:
 * the recorder in main, which cuts each track into chunks at pauses and transcribes them as they
 * come (`transcriber.ts`), in the same one-second batches the window sends. Evals score this path
 * (`pnpm eval:calls --pipeline live`), and a session that came out wrong can be re-run from its
 * kept audio (`pnpm replay:session`). It runs faster than real time, but in the order of a real
 * recording: each second waits for the transcription and speaker labels the ones before it set
 * off. Stopping waits for the last chunks, as a real stop does.
 */

/** The window sends audio to main about once a second (`sessionRecorder.ts`). */
const BATCH = SAMPLE_RATE

function pcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return out
}

export async function replayRecording(
  pageId: string,
  micPath: string,
  systemPath: string | null,
  transcribe?: TranscribeExperiment
): Promise<void> {
  const mic = await readWav(micPath)
  const system = systemPath ? await readWav(systemPath) : null
  await recorderFixture.start(pageId, system !== null, transcribe)
  for (let at = 0; at < mic.length; at += BATCH) {
    recorderFixture.append('mic', pcm16(mic.subarray(at, at + BATCH)))
    if (system) recorderFixture.append('system', pcm16(system.subarray(at, at + BATCH)))
    // Let transcription and speaker labeling keep up between batches, as they do while recording:
    // a second of audio takes them far less than a second.
    await new Promise((resolve) => setImmediate(resolve))
    await recorderFixture.caughtUp()
    await liveLabelsIdle()
  }
  await recorderFixture.stop()
}
