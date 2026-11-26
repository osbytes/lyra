import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { ConfigError } from '../config'

/**
 * One-off tasks run by the same binary as the app, chosen on the command line:
 *
 *   lyra smoke                                  UI and IPC smoke test (pnpm smoke:ui)
 *   lyra screenshot [--review <dir>]            README shot; --review captures every state
 *   lyra meeting <mic.wav> [system.wav]         the real speaker pipeline (pnpm smoke:meeting)
 *     [--offline] [--no-relabel] [--output <file.json>] [--notes local|cloud] [--enroll <owner.wav>]
 *     [--asr whisper|parakeet] [--no-context]   eval experiments: the speech model, and Whisper
 *                                               without the earlier text as its prompt
 *     [--larger-speaker-model]                  label with the opt-in speaker-activity model
 *     [--capture]                               play mic.wav as a fake microphone through the
 *                                               window's real capture path, in real time
 *
 * In development the scripts launch `electron . <task>`. Each task runs in a throwaway profile
 * and exits with its result.
 */

const TASK_NAMES = ['smoke', 'screenshot', 'meeting'] as const
const TaskName = z.enum(TASK_NAMES)

export function isTaskName(value: string): value is z.infer<typeof TaskName> {
  return TaskName.safeParse(value).success
}

/** Options that take a value; every other `--flag` is a switch. */
const VALUE_FLAGS = new Set(['--review', '--output', '--notes', '--enroll', '--asr'])

const absolutePath = z.string().transform((path) => (isAbsolute(path) ? path : resolve(path)))

/** The tokens after a task name, before they're checked against that task's schema. */
type Tokens = { positional: string[]; flags: Record<string, string | true> }

const Smoke = z.object({ kind: z.literal('smoke') }).strict()

const Screenshot = z
  .object({ kind: z.literal('screenshot'), '--review': absolutePath.optional() })
  .strict()
  .transform((args) => ({ kind: args.kind, reviewDir: args['--review'] ?? null }))

const Meeting = z
  .object({
    kind: z.literal('meeting'),
    positional: z.tuple([absolutePath], absolutePath.optional()).or(
      z.tuple([absolutePath, absolutePath])
    ),
    '--offline': z.literal(true).optional(),
    '--no-relabel': z.literal(true).optional(),
    '--output': absolutePath.optional(),
    '--notes': z.enum(['local', 'cloud']).optional(),
    '--enroll': absolutePath.optional(),
    '--asr': z.enum(['whisper', 'parakeet']).optional(),
    '--no-context': z.literal(true).optional(),
    '--larger-speaker-model': z.literal(true).optional(),
    '--capture': z.literal(true).optional()
  })
  .strict()
  .transform((args) => ({
    kind: args.kind,
    mic: args.positional[0],
    system: args.positional[1] ?? null,
    /** `live` replays the audio as a recording; `offline` labels it after the fact. */
    pipeline: args['--offline'] ? ('offline' as const) : ('live' as const),
    /** Off for evals that score the track-labeled lines on their own. */
    relabel: !args['--no-relabel'],
    /** Where to write the labeled segments as JSON, for the eval scorers. */
    output: args['--output'] ?? null,
    notes: args['--notes'] ?? null,
    /** A WAV saved as the laptop owner's voice first, as if they had set it up in People. */
    enroll: args['--enroll'] ?? null,
    /** Which speech model live replays transcribe with (`whisper` is what the app runs). */
    asr: args['--asr'] ?? 'whisper',
    /** Whether Whisper gets a track's earlier text as its prompt. */
    context: !args['--no-context'],
    /** The "Larger speaker model" setting, on for this run. */
    largerSpeakerModel: args['--larger-speaker-model'] === true,
    /**
     * Record through the window (getUserMedia, the AudioContext, the worklet) from a fake
     * microphone playing the WAV, instead of feeding main directly. Mic only: loopback can't be
     * faked.
     */
    capture: args['--capture'] === true
  }))
  .refine((task) => !task.capture || task.system === null, '--capture replays the mic track only')

export type Task = z.output<typeof Smoke> | z.output<typeof Screenshot> | z.output<typeof Meeting>

function tokenize(name: string, rest: readonly string[]): Tokens {
  const tokens: Tokens = { positional: [], flags: {} }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? ''
    // Electron and Chromium switches (--user-data-dir=…) carry an `=`; leave those to them.
    if (arg.startsWith('--') && arg.includes('=')) continue
    if (!arg.startsWith('--')) {
      tokens.positional.push(arg)
    } else if (VALUE_FLAGS.has(arg)) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) throw new ConfigError(`${name}: ${arg} needs a value`)
      tokens.flags[arg] = value
      i++
    } else {
      tokens.flags[arg] = true
    }
  }
  return tokens
}

/**
 * The task named on the command line, or null for a normal launch. `args` are the arguments
 * after the app itself. Anything before the task name is left to Electron; a task with a bad
 * option throws ConfigError.
 */
export function parseTask(args: readonly string[]): Task | null {
  const name = args.find(isTaskName)
  if (name === undefined) return null
  const { positional, flags } = tokenize(name, args.slice(args.indexOf(name) + 1))
  const input = { kind: name, ...flags, ...(positional.length ? { positional } : {}) }
  const result =
    name === 'smoke'
      ? Smoke.safeParse(input)
      : name === 'screenshot'
        ? Screenshot.safeParse(input)
        : Meeting.safeParse(input)
  if (result.success) return result.data
  const problems = result.error.issues.map((issue) =>
    issue.code === 'unrecognized_keys'
      ? `unknown option ${issue.keys.join(', ')}`
      : issue.path[0] === 'positional'
        ? 'give the WAV to replay (meeting <mic.wav> [system.wav])'
        : `${String(issue.path[0] ?? 'arguments')} ${issue.message}`
  )
  throw new ConfigError(`${name}: ${problems.join('; ')}`)
}
