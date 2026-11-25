import { execFile } from 'node:child_process'

const TIMEOUT_MS = 5000

/**
 * Titles of a running app's top-level window, so a browser on the mic can be checked for a
 * meeting tab. Windows only: `Process.MainWindowTitle` is the browser's frontmost window, which
 * shows its active tab. macOS needs the Screen Recording permission to read other apps' window
 * titles, which Lyra doesn't ask for, so there it returns nothing and browsers never prompt.
 *
 * `processName` must come from Lyra's own list of browsers, never from outside input.
 */
export function windowTitles(processName: string): Promise<string[]> {
  if (process.platform !== 'win32' || !/^[\w.-]+$/.test(processName)) return Promise.resolve([])
  const script = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle } | Where-Object { $_ }`
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        // No titles is the safe answer: the browser just doesn't prompt.
        resolve(error ? [] : stdout.split(/\r?\n/).filter((line) => line.trim() !== ''))
      }
    )
  })
}
