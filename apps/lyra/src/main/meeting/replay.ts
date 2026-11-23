import { StreamingTranscriber } from '../../shared/audio/streaming'
import { Timeline } from '../../shared/audio/timeline'
import { SAMPLE_RATE, VoiceDetector } from '../../shared/audio/vad'
import type { TranscriptWord } from '../../shared/types'
import { recorderFixture } from '../recorder'
import { transcribePcm } from '../whisper'
import { mixTracks, readWav } from './wav'

/**
 * Replays recorded audio through what a live recording runs, without a window or a microphone:
 * the renderer's voice detector and streaming transcriber, then the recorder and live speaker
 * identification in main, in the same order and with the same batching. Evals score this path
 * (`pnpm eval:calls --pipeline live`), and a session that came out mislabeled can be re-run from
 * its kept audio (`pnpm replay:session`).
 *
 * Each Whisper pass finishes before the next frame is fed, as on a machine fast enough to keep
 * up, so a replay is deterministic and runs faster than real time.
 */

/** The capture worklet's frame size. */
const FRAME = 512
/** The renderer sends audio to main about once a second (`sessionRecorder.ts`). */
const BATCH = SAMPLE_RATE

function pcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return out
}

export async function replayRecording(pageId: string, micPath: string, systemPath: string | null): Promise<void> {
  const mic = await readWav(micPath)
  const system = systemPath ? await readWav(systemPath) : null
  const timeline = new Timeline()
  timeline.offset = await recorderFixture.start(pageId, system !== null)
  await recorderFixture.ready()

  const failures: Error[] = []
  let lastSpan = { start: 0, end: 0 }
  const streamer = new StreamingTranscriber(transcribePcm, {
    onCommit: (text) => {
      recorderFixture.appendText(text, lastSpan.start, lastSpan.end)
    },
    onWords: (words: TranscriptWord[]) => {
      const mapped = words.map((word) => ({
        text: word.text,
        start: timeline.toRecording(word.start),
        end: timeline.toRecording(word.end)
      }))
      const first = mapped[0]
      const last = mapped.at(-1)
      if (first && last) lastSpan = { start: first.start, end: last.end }
      recorderFixture.appendWords(mapped)
    },
    onLive: () => undefined,
    onError: (error) => {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  })
  const hear = (frame: Float32Array): void => {
    timeline.heard += frame.length
    streamer.append(frame)
  }
  const voice = new VoiceDetector({
    onStart: (frames) => {
      timeline.speechStarted(frames.reduce((sum, frame) => sum + frame.length, 0))
      frames.forEach(hear)
    },
    onFrame: hear,
    onEnd: () => {
      void streamer.finalize()
    }
  })

  let sent = 0
  const send = (upTo: number): void => {
    recorderFixture.append('mic', pcm16(mic.subarray(sent, upTo)))
    if (system) recorderFixture.append('system', pcm16(system.subarray(sent, upTo)))
    sent = upTo
  }
  for (let at = 0; at + FRAME <= mic.length; at += FRAME) {
    timeline.recorded += FRAME
    // The renderer transcribes both sides of a call, mixed (`capture.ts`).
    const frame = mic.subarray(at, at + FRAME)
    voice.push(system ? mixTracks(frame, system.subarray(at, at + FRAME)) : frame)
    if (at + FRAME - sent >= BATCH) send(at + FRAME)
    await streamer.idle()
  }
  send(mic.length)
  voice.flush()
  await streamer.idle()
  const [failure] = failures
  if (failure) throw failure
  await recorderFixture.stop()
}
