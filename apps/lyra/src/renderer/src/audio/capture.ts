import { log } from '../lib/log'
import { SAMPLE_RATE } from '../../../shared/audio/vad'

/** 32 ms frames: small enough for a responsive VAD, large enough to keep messaging cheap. */
const FRAME_SIZE = 512

/**
 * Runs on the audio rendering thread, so UI work on the main thread can never
 * cause dropped samples (unlike the deprecated ScriptProcessorNode).
 */
const WORKLET_SOURCE = `
// Collects 1 channel (mic) or 2 discrete channels (mic, system audio) into frames.
class FrameCollector extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.channels = (options.processorOptions && options.processorOptions.channels) || 1
    this.reset()
  }
  reset() {
    this.frames = []
    for (let c = 0; c < this.channels; c++) this.frames.push(new Float32Array(${FRAME_SIZE}))
    this.filled = 0
  }
  process(inputs) {
    const input = inputs[0]
    const first = input && input[0]
    if (!first) return true
    let read = 0
    while (read < first.length) {
      const count = Math.min(first.length - read, ${FRAME_SIZE} - this.filled)
      for (let c = 0; c < this.channels; c++) {
        const channel = input[c]
        if (channel) this.frames[c].set(channel.subarray(read, read + count), this.filled)
      }
      this.filled += count
      read += count
      if (this.filled === ${FRAME_SIZE}) {
        this.port.postMessage(this.frames, this.frames.map((frame) => frame.buffer))
        this.reset()
      }
    }
    return true
  }
}
registerProcessor('frame-collector', FrameCollector)
`

/**
 * Rumble below the voice (desk knocks, fans, air conditioning, handling noise) is cut before
 * anything else sees the mic: it carries no speech and lifts the level the voice detector compares
 * against. 80 Hz, as Meetily's pipeline uses, is under the lowest voices' fundamentals.
 */
const HIGH_PASS_HZ = 80
/** Sample rates at or under this are a headset's call mode (8 kHz CVSD or 16 kHz mSBC). */
const NARROWBAND_HZ = 16000
/** How often a lost system track is tried again before the meeting carries on with the mic. */
const SYSTEM_RETRIES = 3

export type CaptureHandle = {
  micName: string
  /**
   * The microphone runs at 16 kHz or less: almost always a Bluetooth headset in its call mode,
   * which also turns the computer's audio (the system track) into phone quality.
   */
  narrowband: boolean
  /** Audio engine and microphone track state, for diagnostics. */
  state: () => { context: string; track: string; muted: boolean; systemReopens: number }
  stop: () => void
}

export type OpenedMicrophone = {
  stream: MediaStream
  /** The requested device was unavailable, so the system default was used. */
  usedFallback: boolean
}

/**
 * The microphone raw: Chromium's noise suppression and gain control are off. Whisper is trained on
 * unprocessed audio and loses accuracy on denoised speech (arXiv 2512.17562 found it the model
 * most hurt by enhancement), and the browser's gain moved under the echo gate and the voice
 * detector. Lyra levels the copy it transcribes itself (`shared/audio/level.ts`) and cancels a
 * call's echo against the system track (`shared/audio/aec.ts`): Chromium's own canceller only
 * knows audio this page plays, not the call app's. OpenWhispr records meetings the same way.
 */
function requestMicrophone(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  })
}

function isMissingDevice(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')
  )
}

/** Opens `deviceId` (or the system default), falling back to the default if it's gone. */
export async function openMicrophone(deviceId: string | null = null): Promise<OpenedMicrophone> {
  let stream: MediaStream
  let usedFallback = false
  try {
    stream = await requestMicrophone(deviceId)
  } catch (error) {
    if (!deviceId || !isMissingDevice(error)) throw error
    log('capture', 'chosen microphone unavailable, using default', { deviceId })
    stream = await requestMicrophone(null)
    usedFallback = true
  }
  const track = stream.getAudioTracks()[0]
  if (track?.readyState !== 'live') {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error(
      'The microphone did not start. Check System Settings → Privacy & Security → Microphone.'
    )
  }
  return { stream, usedFallback }
}

export type CaptureOptions = {
  /** System audio (the other side of a call), recorded as its own track. */
  system?: MediaStream
  /** Opens system audio again, when its track ends or the audio devices change. */
  reopenSystem?: () => Promise<MediaStream | null>
  /** Each frame per track, unmixed: for recording a meeting. */
  onTracks?: (mic: Float32Array, system: Float32Array | null) => void
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => {
    track.onended = null
    track.stop()
  })
}

/**
 * Streams 16 kHz mono frames from `stream` to `onFrame` until stopped: the microphone alone,
 * even when system audio is captured beside it (`onTracks` has both).
 */
export async function startCapture(
  stream: MediaStream,
  onFrame: (frame: Float32Array) => void,
  /** The microphone went away (unplugged, Bluetooth switched profile, revoked). */
  onLost: (reason: string) => void,
  options: CaptureOptions = {}
): Promise<CaptureHandle> {
  // Letting the browser resample to 16 kHz gives proper anti-aliasing for free.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  await context.resume()

  const { system, onTracks, reopenSystem } = options
  const channels = system ? 2 : 1
  const source = context.createMediaStreamSource(stream)
  const highPass = new BiquadFilterNode(context, {
    type: 'highpass',
    frequency: HIGH_PASS_HZ,
    Q: Math.SQRT1_2
  })
  source.connect(highPass)
  let systemStream = system ?? null
  let systemSource = system ? context.createMediaStreamSource(system) : null
  const collector = new AudioWorkletNode(context, 'frame-collector', {
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: channels === 2 ? 'discrete' : 'speakers',
    processorOptions: { channels }
  })
  // Chromium only runs nodes that are pulled by the destination, so route through a muted gain.
  const mute = new GainNode(context, { gain: 0 })
  let stopped = false
  // A function, so TypeScript doesn't assume the flag is unchanged across awaits.
  const isStopped = (): boolean => stopped

  collector.port.onmessage = (event: MessageEvent<Float32Array[]>) => {
    if (stopped) return
    const [mic, other] = event.data
    if (!mic) return
    onTracks?.(mic, other ?? null)
    onFrame(mic)
  }
  collector.onprocessorerror = () => {
    log('capture', 'audio worklet crashed')
    if (!stopped) onLost('The audio processor stopped unexpectedly.')
  }
  let merger: ChannelMergerNode | null = null
  if (systemSource) {
    // Each merger input is downmixed to mono: channel 0 = mic, channel 1 = system audio. While
    // system audio is being reopened its input is silent, so the two tracks stay aligned.
    merger = new ChannelMergerNode(context, { numberOfInputs: 2 })
    highPass.connect(merger, 0, 0)
    systemSource.connect(merger, 0, 1)
    merger.connect(collector)
  } else {
    highPass.connect(collector)
  }
  collector.connect(mute).connect(context.destination)

  let systemReopens = 0
  let reopening = false
  const watchSystem = (current: MediaStream): void => {
    const systemTrack = current.getAudioTracks()[0]
    if (!systemTrack) return
    // Losing system audio shouldn't end the meeting; the mic keeps going.
    systemTrack.onended = () => {
      log('capture', 'system audio ended')
      void reconnectSystem('ended')
    }
  }
  /**
   * Swaps in a new system stream: after its track ended (the output device went away), or when
   * the devices changed: loopback opens on whatever output was the default at the time, and may
   * keep listening to it after the call moves to headphones. A brief gap is silence, not drift.
   */
  const reconnectSystem = async (reason: string): Promise<void> => {
    const input = merger
    if (!input || !reopenSystem || reopening || stopped) return
    reopening = true
    try {
      for (let attempt = 1; attempt <= SYSTEM_RETRIES; attempt++) {
        const next = await reopenSystem()
        // Stop can land during the await.
        if (isStopped()) {
          stopTracks(next)
          return
        }
        if (!next) continue
        systemSource?.disconnect()
        stopTracks(systemStream)
        systemStream = next
        systemSource = context.createMediaStreamSource(next)
        systemSource.connect(input, 0, 1)
        watchSystem(next)
        systemReopens++
        log('capture', 'system audio reopened', { reason, attempt })
        return
      }
      log('capture', 'system audio could not be reopened; recording the mic only', { reason })
    } finally {
      reopening = false
    }
  }
  if (system) watchSystem(system)
  const onDeviceChange = (): void => {
    void reconnectSystem('devicechange')
  }
  if (system) navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)

  // macOS suspends audio contexts when devices change or the system interrupts audio.
  context.onstatechange = () => {
    log('capture', `audio context ${context.state}`)
    if (!stopped && context.state !== 'running' && context.state !== 'closed') {
      context.resume().then(
        () => log('capture', `audio context resumed (${context.state})`),
        (error: unknown) => log('capture', 'audio context resume failed', String(error))
      )
    }
  }

  const track = stream.getAudioTracks()[0]
  const micName = track?.label ? track.label : 'Microphone'
  const micRate = track?.getSettings().sampleRate
  const narrowband = micRate !== undefined && micRate <= NARROWBAND_HZ
  if (track) {
    track.onmute = () => log('capture', 'microphone muted by the system', { micName })
    track.onunmute = () => log('capture', 'microphone unmuted', { micName })
    track.onended = () => {
      log('capture', 'microphone track ended', { micName })
      if (!stopped) onLost(`Lost the microphone (${micName}).`)
    }
  }
  log('capture', 'started', {
    micName,
    contextRate: context.sampleRate,
    narrowband,
    settings: track?.getSettings()
  })

  return {
    micName,
    narrowband,
    state: () => ({
      context: context.state,
      track: track?.readyState ?? 'none',
      muted: track?.muted ?? false,
      systemReopens
    }),
    stop: () => {
      if (stopped) return
      stopped = true
      log('capture', 'stopped')
      collector.port.onmessage = null
      context.onstatechange = null
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
      if (track) track.onended = track.onmute = track.onunmute = null
      source.disconnect()
      highPass.disconnect()
      systemSource?.disconnect()
      merger?.disconnect()
      collector.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      stopTracks(systemStream)
      void context.close()
    }
  }
}

/**
 * Asks main for system audio (loopback). The display-media handler in main picks
 * the screen without a picker; the video track is dropped immediately.
 */
export async function openSystemAudio(): Promise<MediaStream | null> {
  try {
    const capture = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    capture.getVideoTracks().forEach((track) => {
      track.stop()
      capture.removeTrack(track)
    })
    if (capture.getAudioTracks().length === 0) {
      log('capture', 'system audio unavailable (no audio track)')
      return null
    }
    log('capture', 'system audio started', { label: capture.getAudioTracks()[0]?.label })
    return capture
  } catch (error) {
    log('capture', 'system audio unavailable', String(error))
    return null
  }
}
