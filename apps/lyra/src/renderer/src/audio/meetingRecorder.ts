import type { AudioTrack } from '../../../shared/types'
import { SAMPLE_RATE } from './vad'

/** Send audio to main about once a second instead of 31 tiny messages. */
const CHUNK_SAMPLES = SAMPLE_RATE

function toPcm16(samples: Float32Array, out: Int16Array, offset: number): void {
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[offset + i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
}

class TrackBuffer {
  private buffer = new Int16Array(CHUNK_SAMPLES)
  private filled = 0

  constructor(private readonly track: AudioTrack) {}

  push(frame: Float32Array): void {
    let read = 0
    while (read < frame.length) {
      const count = Math.min(frame.length - read, CHUNK_SAMPLES - this.filled)
      toPcm16(frame.subarray(read, read + count), this.buffer, this.filled)
      this.filled += count
      read += count
      if (this.filled === CHUNK_SAMPLES) this.flush()
    }
  }

  flush(): void {
    if (this.filled === 0) return
    window.api.appendRecording(this.track, this.buffer.slice(0, this.filled))
    this.filled = 0
  }
}

/** Streams a meeting's mic and system tracks to main, which writes them as WAV files. */
export class MeetingRecorder {
  private readonly mic = new TrackBuffer('mic')
  private readonly system: TrackBuffer | null

  private constructor(withSystem: boolean) {
    this.system = withSystem ? new TrackBuffer('system') : null
  }

  static async start(pageId: string, withSystem: boolean): Promise<MeetingRecorder> {
    await window.api.startRecording(pageId, withSystem)
    return new MeetingRecorder(withSystem)
  }

  push(mic: Float32Array, system: Float32Array | null): void {
    this.mic.push(mic)
    if (system) this.system?.push(system)
  }

  async stop(): Promise<void> {
    this.mic.flush()
    this.system?.flush()
    await window.api.stopRecording()
  }
}
