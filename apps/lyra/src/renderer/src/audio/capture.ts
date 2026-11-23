import { log } from '../lib/log'
import { SAMPLE_RATE } from './vad'

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

export type CaptureHandle = {
  micName: string
  /** Audio engine and microphone track state, for diagnostics. */
  state: () => { context: string; track: string; muted: boolean }
  stop: () => void
}

export type OpenedMicrophone = {
  stream: MediaStream
  /** The requested device was unavailable, so the system default was used. */
  usedFallback: boolean
}

function requestMicrophone(deviceId: string | null): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
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

/** Streams 16 kHz mono frames from `stream` to `onFrame` until stopped. */
export type CaptureOptions = {
  /** System audio (the other side of a call), mixed in for transcription. */
  system?: MediaStream
  /** Each frame per track, unmixed: for recording a meeting. */
  onTracks?: (mic: Float32Array, system: Float32Array | null) => void
}

/** Sums two tracks, clamped, so quiet speakers on either side stay audible. */
function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const sum = (a[i] ?? 0) + (b[i] ?? 0)
    out[i] = sum > 1 ? 1 : sum < -1 ? -1 : sum
  }
  return out
}

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

  const { system, onTracks } = options
  const channels = system ? 2 : 1
  const source = context.createMediaStreamSource(stream)
  const systemSource = system ? context.createMediaStreamSource(system) : null
  const collector = new AudioWorkletNode(context, 'frame-collector', {
    channelCount: channels,
    channelCountMode: 'explicit',
    channelInterpretation: channels === 2 ? 'discrete' : 'speakers',
    processorOptions: { channels }
  })
  // Chromium only runs nodes that are pulled by the destination, so route through a muted gain.
  const mute = new GainNode(context, { gain: 0 })
  let stopped = false

  collector.port.onmessage = (event: MessageEvent<Float32Array[]>) => {
    if (stopped) return
    const [mic, other] = event.data
    if (!mic) return
    onTracks?.(mic, other ?? null)
    onFrame(other ? mix(mic, other) : mic)
  }
  collector.onprocessorerror = () => {
    log('capture', 'audio worklet crashed')
    if (!stopped) onLost('The audio processor stopped unexpectedly.')
  }
  let merger: ChannelMergerNode | null = null
  if (systemSource) {
    // Each merger input is downmixed to mono: channel 0 = mic, channel 1 = system audio.
    merger = new ChannelMergerNode(context, { numberOfInputs: 2 })
    source.connect(merger, 0, 0)
    systemSource.connect(merger, 0, 1)
    merger.connect(collector)
  } else {
    source.connect(collector)
  }
  collector.connect(mute).connect(context.destination)

  const systemTrack = system?.getAudioTracks()[0]
  if (systemTrack) {
    // Losing system audio shouldn't end the meeting; the mic keeps going.
    systemTrack.onended = () => {
      log('capture', 'system audio ended')
    }
  }

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
    settings: track?.getSettings()
  })

  return {
    micName,
    state: () => ({
      context: context.state,
      track: track?.readyState ?? 'none',
      muted: track?.muted ?? false
    }),
    stop: () => {
      if (stopped) return
      stopped = true
      log('capture', 'stopped')
      collector.port.onmessage = null
      context.onstatechange = null
      if (track) track.onended = track.onmute = track.onunmute = null
      source.disconnect()
      systemSource?.disconnect()
      merger?.disconnect()
      collector.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      system?.getTracks().forEach((track) => track.stop())
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
