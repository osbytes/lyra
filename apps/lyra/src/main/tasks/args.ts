import { isAbsolute, resolve } from 'node:path'
import { ConfigError } from '../config'

/**
 * One-off tasks run by the same binary as the app, chosen on the command line:
 *
 *   lyra smoke                                  UI and IPC smoke test (pnpm smoke:ui)
 *   lyra screenshot [--review <dir>]            README shot; --review captures every state
 *   lyra meeting <mic.wav> [system.wav]         the real speaker pipeline (pnpm smoke:meeting)
 *     [--offline] [--no-relabel] [--output <file.json>] [--notes local|claude]
 *
 * In development the scripts launch `electron . <task>`. Each task runs in a throwaway profile
 * and exits with its result.
 */
export type Task =
  | { kind: 'smoke' }
  | { kind: 'screenshot'; reviewDir: string | null }
  | {
      kind: 'meeting'
      mic: string
      system: string | null
      /** `live` replays the audio as a recording; `offline` labels it after the fact. */
      pipeline: 'live' | 'offline'
      /** Off for evals that score live identification on its own. */
      relabel: boolean
      /** Where to write the labeled segments as JSON, for the eval scorers. */
      output: string | null
      notes: 'local' | 'claude' | null
    }

const TASKS = ['smoke', 'screenshot', 'meeting'] as const
type TaskName = (typeof TASKS)[number]

export function isTaskName(value: string): value is TaskName {
  return TASKS.some((name) => name === value)
}

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(path))

/**
 * The task named on the command line, or null for a normal launch. `args` are the arguments
 * after the app itself. Chromium switches and anything else unrecognized before the task name
 * are left alone; a task with a bad option throws ConfigError.
 */
export function parseTask(args: readonly string[]): Task | null {
  const at = args.findIndex(isTaskName)
  const name = args[at]
  if (name === undefined || !isTaskName(name)) return null
  const rest = args.slice(at + 1)
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ''
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const takesValue = arg === '--review' || arg === '--output' || arg === '--notes'
    if (!takesValue) {
      flags.set(arg, true)
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new ConfigError(`${name}: ${arg} needs a value`)
    flags.set(arg, value)
    i++
  }
  const value = (flag: string): string | null => {
    const found = flags.get(flag)
    return typeof found === 'string' ? found : null
  }
  const allow = (...known: string[]): void => {
    const unknown = [...flags.keys()].filter((flag) => !known.includes(flag))
    // Electron and Chromium switches (--user-data-dir=…) carry an `=`; leave those to them.
    const ours = unknown.filter((flag) => !flag.includes('='))
    if (ours.length) throw new ConfigError(`${name}: unknown option ${ours.join(', ')}`)
  }

  switch (name) {
    case 'smoke':
      allow()
      return { kind: 'smoke' }
    case 'screenshot': {
      allow('--review')
      const review = value('--review')
      return { kind: 'screenshot', reviewDir: review === null ? null : absolute(review) }
    }
    case 'meeting': {
      allow('--offline', '--no-relabel', '--output', '--notes')
      const [mic, system] = positional
      if (!mic) throw new ConfigError('meeting: give the WAV to replay (meeting <mic.wav> [system.wav])')
      const notes = value('--notes')
      if (notes !== null && notes !== 'local' && notes !== 'claude') {
        throw new ConfigError(`meeting: --notes must be local or claude (got "${notes}")`)
      }
      const output = value('--output')
      return {
        kind: 'meeting',
        mic: absolute(mic),
        system: system ? absolute(system) : null,
        pipeline: flags.has('--offline') ? 'offline' : 'live',
        relabel: !flags.has('--no-relabel'),
        output: output === null ? null : absolute(output),
        notes
      }
    }
  }
}
