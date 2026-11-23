import { appendTranscript, mapPosition, normalizeTag } from './text'
import { stem } from './time'
import type { DemoState, FileSelection, Session, Settings } from './types'

export type Action =
  | { type: 'tick' }
  | { type: 'open'; id: string }
  | { type: 'create' }
  | { type: 'editTitle'; title: string }
  | { type: 'editBody'; body: string }
  | { type: 'editSummary'; summary: string }
  | { type: 'tag'; tag: string }
  | { type: 'untag'; tag: string }
  | { type: 'remove'; id: string }
  | { type: 'undoRemove' }
  | { type: 'forgetRemoved' }
  | { type: 'filter'; tag: string | null }
  | { type: 'panel'; open: boolean }
  | { type: 'beginTranscription' }
  | { type: 'transcribe'; chunk: string }
  | { type: 'endTranscription'; seconds: number }
  | { type: 'confirmSpeaker'; id: string }
  | { type: 'nameSpeaker'; id: string; name: string }
  | { type: 'editLine'; id: string; text: string }
  | { type: 'restoreLine'; id: string }
  | { type: 'toggleAction'; index: number }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'selectFile'; selection: FileSelection }
  | { type: 'notesBusy'; busy: boolean }

/** Every action carries the demo clock's time, so the reducer stays pure. */
export type StampedAction = Action & { at: number }

export const byRecent = (a: Session, b: Session): number => b.editedAt - a.editedAt

function updateSession(state: DemoState, id: string, change: (session: Session) => Session): DemoState {
  return { ...state, sessions: state.sessions.map((session) => (session.id === id ? change(session) : session)) }
}

const updateCurrent = (state: DemoState, change: (session: Session) => Session): DemoState =>
  updateSession(state, state.currentId, change)

const touchMeeting = (state: DemoState, at: number): DemoState => {
  const meeting = state.sessions.find((session) => session.meeting)
  return meeting ? updateSession(state, meeting.id, (s) => ({ ...s, editedAt: at })) : state
}

function newSession(state: DemoState, at: number): Session {
  let started = at
  while (state.sessions.some((session) => session.id === `${stem(started)}.txt`)) started += 1000
  return {
    id: `${stem(started)}.txt`,
    ext: 'txt',
    title: '',
    tags: [],
    body: '',
    summary: null,
    meeting: false,
    startedAt: started,
    editedAt: at,
    seconds: 0,
    tracks: state.settings.systemAudio ? ['mic', 'system'] : ['mic'],
    fromDemo: true
  }
}

function remove(state: DemoState, id: string, at: number): DemoState {
  const index = state.sessions.findIndex((session) => session.id === id)
  const target = state.sessions[index]
  if (!target) return state
  let sessions = state.sessions.filter((session) => session.id !== id)
  let currentId = state.currentId
  if (currentId === id) {
    const [next] = [...sessions].sort(byRecent)
    if (next) currentId = next.id
    else {
      const blank = newSession({ ...state, sessions }, at)
      sessions = [blank]
      currentId = blank.id
    }
  }
  const selectedFile: FileSelection =
    state.selectedFile.kind !== 'sessions' && state.selectedFile.id === id
      ? { kind: 'export', id: currentId }
      : state.selectedFile
  return { ...state, sessions, currentId, selectedFile, transcriberAt: null, trashed: { session: target, index } }
}

export function reducer(previous: DemoState, action: StampedAction): DemoState {
  const at = action.at
  const state = { ...previous, now: at }
  switch (action.type) {
    case 'tick':
      return state
    case 'open':
      return state.sessions.some((s) => s.id === action.id)
        ? { ...state, currentId: action.id, transcriberAt: null }
        : state
    case 'create': {
      const session = newSession(state, at)
      return {
        ...state,
        sessions: [...state.sessions, session],
        currentId: session.id,
        tagFilter: null,
        transcriberAt: null,
        selectedFile: { kind: 'export', id: session.id }
      }
    }
    case 'editTitle':
      return updateCurrent(state, (s) => ({ ...s, title: action.title, editedAt: at }))
    case 'editBody': {
      const current = state.sessions.find((s) => s.id === state.currentId)
      const transcriberAt =
        current && state.transcriberAt !== null
          ? mapPosition(current.body, action.body, state.transcriberAt)
          : state.transcriberAt
      return { ...updateCurrent(state, (s) => ({ ...s, body: action.body, editedAt: at })), transcriberAt }
    }
    case 'editSummary':
      return updateCurrent(state, (s) => ({ ...s, summary: action.summary, editedAt: at }))
    case 'tag': {
      const tag = normalizeTag(action.tag)
      if (!tag) return state
      return updateCurrent(state, (s) => (s.tags.includes(tag) ? s : { ...s, tags: [...s.tags, tag], editedAt: at }))
    }
    case 'untag':
      return updateCurrent(state, (s) => ({ ...s, tags: s.tags.filter((t) => t !== action.tag), editedAt: at }))
    case 'remove':
      return remove(state, action.id, at)
    case 'undoRemove': {
      if (!state.trashed) return state
      const { session, index } = state.trashed
      const sessions = [...state.sessions]
      sessions.splice(Math.min(index, sessions.length), 0, session)
      return { ...state, sessions, currentId: session.id, trashed: null, transcriberAt: null }
    }
    case 'forgetRemoved':
      return { ...state, trashed: null }
    case 'filter':
      return { ...state, tagFilter: action.tag }
    case 'panel':
      return { ...state, panel: action.open }
    case 'beginTranscription': {
      const current = state.sessions.find((s) => s.id === state.currentId)
      if (!current) return state
      const withAudio = updateCurrent(state, (s) =>
        state.settings.systemAudio && !s.tracks.includes('system') ? { ...s, tracks: [...s.tracks, 'system'] } : s
      )
      return { ...withAudio, transcriberAt: current.body.length }
    }
    case 'transcribe': {
      const current = state.sessions.find((s) => s.id === state.currentId)
      if (!current || !action.chunk) return state
      const index = Math.min(state.transcriberAt ?? current.body.length, current.body.length)
      const before = current.body.slice(0, index)
      const joined = appendTranscript(before, action.chunk)
      const inserted = joined.startsWith(before) ? joined.slice(before.length) : action.chunk
      const body = before + inserted + current.body.slice(index)
      return { ...updateCurrent(state, (s) => ({ ...s, body, editedAt: at })), transcriberAt: index + inserted.length }
    }
    case 'endTranscription':
      return {
        ...updateCurrent(state, (s) => ({ ...s, seconds: s.seconds + action.seconds, editedAt: at })),
        transcriberAt: null
      }
    case 'confirmSpeaker':
      return touchMeeting(
        { ...state, speakers: state.speakers.map((s) => (s.id === action.id ? { ...s, confirmed: true } : s)) },
        at
      )
    case 'nameSpeaker': {
      const name = action.name.trim()
      if (!name) return state
      const speakers = state.speakers.map((s) =>
        s.id === action.id ? { ...s, name, confirmed: true, personId: s.personId ?? 'p-new' } : s
      )
      return touchMeeting({ ...state, speakers }, at)
    }
    case 'editLine':
      return touchMeeting(
        { ...state, lines: state.lines.map((l) => (l.id === action.id ? { ...l, text: action.text } : l)) },
        at
      )
    case 'restoreLine':
      return touchMeeting(
        { ...state, lines: state.lines.map((l) => (l.id === action.id ? { ...l, text: l.original } : l)) },
        at
      )
    case 'toggleAction':
      return {
        ...state,
        doneActions: state.doneActions.map((done, i) => (i === action.index ? !done : done))
      }
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } }
    case 'selectFile':
      return { ...state, selectedFile: action.selection }
    case 'notesBusy':
      if (action.busy) return { ...state, notesBusy: true }
      // Rewriting regenerates the notes from the transcript, dropping hand edits.
      return {
        ...state,
        notesBusy: false,
        sessions: state.sessions.map((s) => (s.meeting ? { ...s, summary: null, editedAt: at } : s))
      }
  }
}
