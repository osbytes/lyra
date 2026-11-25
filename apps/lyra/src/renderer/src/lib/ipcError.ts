/**
 * The message main threw, as a person should read it. Electron wraps a rejected `invoke` as
 * "Error invoking remote method 'area:verb': Error: <message>"; the wrapper means nothing to
 * the user, so it is cut off.
 */
export function ipcErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '').trim()
  return message || fallback
}
