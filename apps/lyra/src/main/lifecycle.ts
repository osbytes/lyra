/**
 * Whether the app is on its way out. Work cut off by quitting (a worker killed, a call aborted)
 * fails like any other; this tells it apart, so a step interrupted by the quit stays owed and is
 * resumed at the next start instead of being marked done.
 */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}
