import { SAMPLE_RATE } from './vad'

/**
 * The transcriber only hears speech (the voice detector drops silence), so its timestamps
 * skip the pauses. Each time speech starts, note where the transcriber's clock and the
 * recording's clock were, and map word times back onto the recording.
 */
export class Timeline {
  private anchors: { heard: number; recorded: number }[] = []
  /** Where this recording starts on the session's timeline, in seconds. */
  offset = 0
  /** Samples of audio captured so far. */
  recorded = 0
  /** Samples fed to the transcriber so far. */
  heard = 0

  speechStarted(prerollSamples: number): void {
    this.anchors.push({ heard: this.heard, recorded: Math.max(0, this.recorded - prerollSamples) })
  }

  toRecording(seconds: number): number {
    const at = seconds * SAMPLE_RATE
    let anchor = this.anchors[0] ?? { heard: 0, recorded: 0 }
    for (const next of this.anchors) {
      if (next.heard > at) break
      anchor = next
    }
    return +(this.offset + (at - anchor.heard + anchor.recorded) / SAMPLE_RATE).toFixed(3)
  }
}
