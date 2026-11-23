import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  HotkeyStatus,
  MeetingStatus,
  MicPrompt,
  OverlayFrame,
  Person,
  Page,
  SessionCommand,
  SessionState,
  SessionUpdate,
  Settings,
  UpdateStatus,
  VoicePagesApi,
  WhisperStatus
} from '../shared/types'

// IPC payloads are typed by contract with main; this is the one place we trust them.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function subscribe<T = undefined>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void => {
    callback(value)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: VoicePagesApi = {
  listPages: () => ipcRenderer.invoke('pages:list'),
  getPage: (id) => ipcRenderer.invoke('pages:get', id),
  createPage: (options) => ipcRenderer.invoke('pages:create', options ?? {}),
  savePage: (page) => ipcRenderer.invoke('pages:save', page),
  deletePage: (id) => ipcRenderer.invoke('pages:delete', id),
  onPagesChanged: (callback) => subscribe('pages:changed', () => {
      callback()
    }),
  openSession: (id) => ipcRenderer.invoke('sessions:open', id),
  updateSession: (id, update) => ipcRenderer.invoke('sessions:update', id, update),
  closeSession: (id) => {
    ipcRenderer.send('sessions:close', id)
  },
  onSessionUpdate: (callback) => subscribe<SessionUpdate>('sessions:update', callback),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  onSettingsChanged: (callback) => subscribe<Settings>('settings:changed', callback),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  moveNotes: (fromDir) => ipcRenderer.invoke('notes:move', fromDir),
  revealNotesFolder: () => ipcRenderer.invoke('notes:reveal'),
  onSessionCommand: (callback) => subscribe<SessionCommand>('session:command', callback),
  reportSession: (state) => {
    ipcRenderer.send('session:report', state)
  },
  reportOverlayFrame: (frame) => {
    ipcRenderer.send('overlay:frame', frame)
  },
  getSessionState: () => ipcRenderer.invoke('session:get'),
  onSessionState: (callback) => subscribe<SessionState>('session:state', callback),
  onOverlayFrame: (callback) => subscribe<OverlayFrame>('overlay:frame', callback),
  onMicPrompt: (callback) => subscribe<MicPrompt | null>('prompt:show', callback),
  answerMicPrompt: (answer) => {
    ipcRenderer.send('prompt:answer', answer)
  },
  requestStop: () => {
    ipcRenderer.send('session:requestStop')
  },
  showMainWindow: () => {
    ipcRenderer.send('window:showMain')
  },
  getHotkeyStatus: () => ipcRenderer.invoke('hotkey:status'),
  onHotkeyStatus: (callback) => subscribe<HotkeyStatus[]>('hotkey:status', callback),
  startRecording: (pageId, withSystem, kind) =>
    ipcRenderer.invoke('recorder:start', pageId, withSystem, kind),
  appendRecording: (track, pcm16) => {
    ipcRenderer.send('recorder:append', track, pcm16)
  },
  appendRecordingWords: (words) => {
    ipcRenderer.send('recorder:words', words)
  },
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  sessionAudio: (pageId, start, end) => ipcRenderer.invoke('sessions:audio', pageId, start, end),
  listPeople: () => ipcRenderer.invoke('people:list'),
  onPeopleChanged: (callback) => subscribe<Person[]>('people:changed', callback),
  enrollPerson: (name, pcm, self) => ipcRenderer.invoke('people:enroll', name, pcm, self),
  renamePerson: (id, name) => ipcRenderer.invoke('people:rename', id, name),
  setSelfPerson: (id) => ipcRenderer.invoke('people:setSelf', id),
  deletePerson: (id) => ipcRenderer.invoke('people:delete', id),
  assignSpeaker: (pageId, speakerId, assignment) =>
    ipcRenderer.invoke('meeting:assign', pageId, speakerId, assignment),
  onMeetingStatus: (callback) => subscribe<MeetingStatus>('meeting:status', callback),
  generateNotes: (pageId) => ipcRenderer.invoke('notes:generate', pageId),
  hasClaudeKey: () => ipcRenderer.invoke('secrets:hasClaudeKey'),
  setClaudeKey: (key) => ipcRenderer.invoke('secrets:setClaudeKey', key),
  copyText: (text) => clipboard.writeText(text),
  platform: process.platform,
  warmUp: () => ipcRenderer.invoke('whisper:warmUp'),
  transcribe: (pcm, prompt) => ipcRenderer.invoke('whisper:transcribe', pcm, prompt),
  log: (scope, message, data) => ipcRenderer.send('log:write', scope, message, data),
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: WhisperStatus): void => {
      callback(status)
    }
    ipcRenderer.on('whisper:status', listener)
    return () => {
      ipcRenderer.removeListener('whisper:status', listener)
    }
  },
  startUpdate: () => ipcRenderer.invoke('updater:start'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => {
      callback(status)
    }
    ipcRenderer.on('updater:status', listener)
    void ipcRenderer.invoke('updater:get').then((status: UpdateStatus) => {
      callback(status)
    })
    return () => {
      ipcRenderer.removeListener('updater:status', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type { Page }
