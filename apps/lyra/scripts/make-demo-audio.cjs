// Generates a two-speaker demo meeting with the system's speech voices, on Windows (SAPI: David,
// Zira) or macOS (`say`: Daniel, Samantha), through scripts/eval/tts.cjs.
//   node scripts/make-demo-audio.cjs [--out test-audio]
// Writes lineN.wav (alternating speakers, even = first voice, for diarize-spike --lines) and
// meeting.wav (16 kHz mono 16-bit, for `pnpm smoke:meeting`). Synthetic speech, safe to share.
// SCRIPT is the ground truth for the transcript and for who said each line; keep it in step with
// scripts/make-demo-audio.ps1, the Windows-only original.
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { render } = require('./eval/tts.cjs')
const { RATE, readWav, writeWav } = require('./eval/wav.cjs')

const SCRIPT = [
  'Good morning everyone. Let us start the weekly planning meeting.',
  'Thanks David. I finished the onboarding flow and it is ready for review.',
  'Great. Are there any blockers on the release for Friday?',
  'One. The Windows installer still fails when the notes folder is on a network drive.',
  'I can look at that today. I will also update the changelog.',
  'Perfect. Sarah, can you send the customer a status update after lunch?',
  'Yes, I will write it up and share it by two in the afternoon.',
  'Then we are done. Thanks everybody, see you next week.'
]

const GAP_SECONDS = 0.6

const outFlag = process.argv.indexOf('--out')
const out = resolve(outFlag >= 0 ? (process.argv[outFlag + 1] ?? 'test-audio') : 'test-audio')
mkdirSync(out, { recursive: true })

// tts.cjs caches clips by voice and text, so a rerun only renders lines that changed.
const clips = render(
  SCRIPT.map((text, index) => ({ voice: index % 2, text })),
  join(out, '.clips')
)

const gap = new Float32Array(Math.round(RATE * GAP_SECONDS))
const parts = []
clips.forEach((clip, index) => {
  const samples = readWav(clip)
  writeWav(join(out, `line${String(index)}.wav`), samples)
  parts.push(samples, gap)
})

const meeting = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
let at = 0
for (const part of parts) {
  meeting.set(part, at)
  at += part.length
}
const meetingPath = join(out, 'meeting.wav')
writeWav(meetingPath, meeting)
console.log(`${meetingPath}: ${(meeting.length / RATE).toFixed(1)}s, ${String(SCRIPT.length)} lines, speakers alternate`)
