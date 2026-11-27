/**
 * Which of Chromium's system-audio sources the display-media handler answers with.
 *
 * `loopback` on Windows opens WASAPI loopback on the default output in Chromium's own format
 * (stereo float). An output set to surround (a 7.1 gaming headset) refuses that with
 * AUDCLNT_E_UNSUPPORTED_FORMAT, so nothing of the call is recorded. `loopbackWithoutChrome`
 * uses Windows' process loopback instead: every app's audio but Lyra's own, converted by
 * Windows to the format asked for, on whichever device it plays. It needs Windows 10 build
 * 20348 or later; older builds keep device loopback. Elsewhere `loopback` is the only source.
 */
export type SystemAudioSource = 'loopback' | 'loopbackWithoutChrome'

/** The first Windows build with process loopback capture (Windows 11 and Server 2022). */
export const PROCESS_LOOPBACK_BUILD = 20348

/** `release` is `os.release()`: "10.0.22631" on Windows 11. */
export function systemAudioSource(platform: string, release: string): SystemAudioSource {
  if (platform !== 'win32') return 'loopback'
  const build = Number(release.split('.')[2])
  return Number.isInteger(build) && build >= PROCESS_LOOPBACK_BUILD ? 'loopbackWithoutChrome' : 'loopback'
}
