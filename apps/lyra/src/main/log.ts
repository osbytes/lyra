import { app } from 'electron'
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/**
 * The app log. Each entry is one JSON object per line in `<userData>/logs/lyra.log` (rotated to
 * `lyra.old.log` past a few megabytes), so an issue report can be filtered and parsed, and a
 * readable line in the terminal for development.
 *
 * Entries carry ids, counts and timings, never note text, transcripts or keys. The UI smoke test
 * checks the file for the content it wrote.
 */

const MAX_BYTES = 5 * 1024 * 1024

type Sink = { path: string; stream: WriteStream }

let sink: Sink | null | undefined

function openSink(): Sink | null {
  if (sink !== undefined) return sink
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'lyra.log')
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
      renameSync(path, join(dir, 'lyra.old.log'))
    }
    // Appends without blocking the main process on every line, unlike appendFileSync.
    const stream = createWriteStream(path, { flags: 'a' })
    stream.on('error', () => {
      // Logging must never break dictation; stop writing the file and keep the terminal line.
      sink = null
    })
    sink = { path, stream }
  } catch {
    sink = null
  }
  return sink
}

export function logPath(): string | null {
  return openSink()?.path ?? null
}

/** Resolves once every line logged so far has reached the file. */
export function flushLog(): Promise<void> {
  const open = openSink()
  if (!open) return Promise.resolve()
  return new Promise((resolve) => {
    open.stream.write('', () => {
      resolve()
    })
  })
}

function serializable(data: unknown): unknown {
  if (data instanceof Error) return { error: data.message, stack: data.stack }
  return data
}

/** JSON text for `value`, or a placeholder when it can't be serialized (a cycle, a BigInt). */
function json(value: unknown): string {
  try {
    // Inside an array, values JSON can't hold (undefined, functions) come out as null rather than
    // vanishing, so the line stays valid JSON.
    return JSON.stringify([value]).slice(1, -1)
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * False once the terminal is gone (the window that ran `pnpm dev` closed, or Ctrl+C took it
 * first). Writing to it then fails with EIO or EPIPE; without a listener that failure is an
 * uncaught exception, whose handler logs, which writes to the dead terminal again, forever.
 */
let terminal = true
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    terminal = false
  })
}

export function log(scope: string, message: string, data?: unknown): void {
  const time = new Date().toISOString()
  const head = `{"time":${json(time)},"scope":${json(scope)},"message":${json(message)}`
  const detail = data === undefined ? '' : json(serializable(data))
  if (terminal) console.log(`${time} [${scope}] ${message}${detail ? ` ${detail}` : ''}`)
  openSink()?.stream.write(`${head}${detail ? `,"data":${detail}` : ''}}\n`)
}
