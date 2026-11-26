import { snapshotOf } from '../../shared/sessionDoc'
import type { AudioTrack } from '../../shared/types'
import { log } from '../log'
import { identifiesSpeakers, onLiveChunk, recordingPageId, type LiveTake } from '../recorder'
import type { TakeWord } from '../takeWriter'
import { changedLabels, noteRound } from './labelChanges'
import { mergeSamePerson, mergeTinySpeakers, nameSpeakers } from './pipeline'
import { assignWords, buildLines, liveWords, matchSpeakers, writeLines, type HeardWord } from './relabel'
import { ensureSpeakerModels, rollDiarize } from './speakers'
import { movedLines, pinnedSpeakers } from './speakerRules'
import { DIARIZE_THRESHOLD } from './thresholds'
import { passClusters } from './voiceprints'

/**
 * Speaker labels while a recording is still going. Lines are written with no speaker
 * (`takeWriter.ts`); every half minute the recording so far is diarized the way a finished one is
 * (`rollingDiarizer.ts` in the speaker worker: the same windows, voiceprints and clustering,
 * kept between rounds so a round costs only the new audio) and the lines up to there get their
 * speakers. Words said since stay unlabeled until the next round: a name is shown once the
 * voices have been compared, never on a guess from the track. Nothing here is kept as a pass
 * or teaches a saved voice; the pass after the recording stops (`relabel.ts`) settles it.
 */

/** The first round waits for this much of a take: under it there is too little to tell voices apart. */
const FIRST_SECONDS = 20
/** Rounds are this far apart, in recorded audio. */
const EVERY_SECONDS = 30
/**
 * …or this many times what the last round took, when that is longer (the first round of a take
 * that continues a long session, a machine under load): labeling must not crowd out transcription.
 */
const COST_FACTOR = 4

/** Speakers of words no round has reached: one per track, so the tracks stay on separate lines. */
const UNSETTLED: Readonly<Record<AudioTrack, number>> = { mic: -1, system: -2 }

type Schedule = { pageId: string; offset: number; nextAt: number }

let schedule: Schedule | null = null
let round: Promise<void> | null = null

/** The speaker of each word: diarized up to `settledTo`, its track's placeholder after. */
export function liveSpeakers(
  words: readonly HeardWord[],
  segments: Parameters<typeof assignWords>[1],
  settledTo: number
): number[] {
  const settled = words.filter((word) => word.start < settledTo)
  const assigned = assignWords(settled, segments)
  let next = 0
  return words.map((word) =>
    word.start < settledTo ? (assigned[next++] ?? 0) : UNSETTLED[word.track === 'system' ? 'system' : 'mic']
  )
}

/**
 * A line's id from its first word (its track and when it starts), so the same line keeps its id
 * from one round to the next and lines of the two tracks that start together still differ.
 */
const lineId = (first: HeardWord | undefined): string =>
  `roll-${first?.track ?? 'mix'}-${String(Math.round((first?.start ?? 0) * 1000))}`

async function label(take: LiveTake): Promise<void> {
  const { pageId, micPath, systemPath, writer } = take
  const started = Date.now()
  const models = await ensureSpeakerModels()
  // Earlier takes' words are in live.json; this take's are saved there only when it stops.
  const earlier = (await liveWords(pageId)).filter((word) => word.start < take.offset)
  const result = await rollDiarize({
    key: pageId,
    micPath,
    systemPath,
    models,
    threshold: DIARIZE_THRESHOLD,
    words: [...earlier, ...writer.heardSoFar()].map(({ start, end }) => ({ start, end }))
  })
  if (result.segments.length === 0 || recordingPageId() !== pageId) return
  const merged = await mergeSamePerson(mergeTinySpeakers(result), pageId, systemPath !== null)
  const heard = [...earlier, ...writer.heardSoFar()]
  const voices = new Set(liveSpeakers(heard, merged.segments, merged.seconds).filter((speaker) => speaker >= 0))
  // Only voices with words get a name, and never "me" from being on the mic: someone else may be.
  const { speakers: named } = await nameSpeakers(
    {
      ...merged,
      segments: merged.segments.filter((segment) => voices.has(segment.speaker)),
      clusters: merged.clusters.filter((cluster) => voices.has(cluster.speaker))
    },
    { pageId, hasSystemTrack: false, quiet: true }
  )
  const origins = await passClusters(pageId)

  const written = await writer.rewrite((doc, own: readonly TakeWord[]) => {
    if (recordingPageId() !== pageId) return null
    const { transcript, speakers: known } = snapshotOf(doc)
    const words: HeardWord[] = [...earlier, ...own]
    const moved = movedLines(transcript, origins)
    const pins = pinnedSpeakers(words, moved)
    const speakers = liveSpeakers(words, merged.segments, merged.seconds)
    const lines = buildLines(words, speakers, pins)
    // The lines hold these same word objects; this gets back the track each was heard on.
    const heardAs = new Map<object, HeardWord>(words.map((word) => [word, word]))
    const movedIds = new Set(moved.map((line) => line.id))
    const continues = matchSpeakers(
      lines.filter((line) => line.pinned === null && line.speaker >= 0),
      transcript.filter((line) => !movedIds.has(line.id))
    )
    writeLines(doc, {
      known,
      named,
      continues,
      lines,
      lineId: (_index, line) => lineId(heardAs.get(line.words[0] ?? {})),
      raw: false
    })
    // Labels a reader already saw that this round took back: the cost of labeling early.
    const { changed } = changedLabels(transcript, snapshotOf(doc).transcript)
    return {
      words: words.length,
      waiting: speakers.filter((speaker) => speaker < 0).length,
      lines: lines.length,
      changedSeconds: +changed.toFixed(1)
    }
  })
  if (!written) return
  noteRound(pageId, written.changedSeconds)
  log('relabel', 'labeled so far', {
    pageId,
    audioSeconds: +merged.seconds.toFixed(1),
    speakers: named.length,
    ...written,
    // What it cost: the worker's share, how much audio was new, and how much was kept.
    ms: Date.now() - started,
    workerMs: result.stats.ms,
    newSeconds: +(merged.seconds - result.stats.from).toFixed(1),
    windows: result.stats.windows,
    embedded: result.stats.embedded
  })
}

function onChunk(take: LiveTake): void {
  if (!identifiesSpeakers()) return
  if (schedule?.pageId !== take.pageId || schedule.offset !== take.offset) {
    schedule = { pageId: take.pageId, offset: take.offset, nextAt: take.offset + FIRST_SECONDS }
  }
  const current = schedule
  if (round || take.seconds < current.nextAt) return
  const started = Date.now()
  round = label(take)
    .catch((error: unknown) => {
      log('relabel', 'could not label the recording so far', {
        pageId: take.pageId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    .finally(() => {
      round = null
      current.nextAt = take.seconds + Math.max(EVERY_SECONDS, (COST_FACTOR * (Date.now() - started)) / 1000)
    })
}

/** Starts labeling recordings as they go; call once, where the recorder is set up. */
export function startLiveLabels(): void {
  onLiveChunk(onChunk)
}

/** Resolves once no round is running (a replay waits on this, as real time would have). */
export async function liveLabelsIdle(): Promise<void> {
  await round
}
