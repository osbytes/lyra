import { contextBridge, ipcRenderer } from 'electron'
import type { ActivityItem } from '../shared/activity'
import type {
  HotkeyStatus,
  MeetingStatus,
  MicPrompt,
  ModelStatus,
  OverlayFrame,
  Person,
  Page,
  SessionCommand,
  SessionChangeEvent,
  SessionState,
  RecorderFailure,
  TranscriptProgress,
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
  searchPages: (query) => ipcRenderer.invoke('pages:search', query),
  getPage: (id) => ipcRenderer.invoke('pages:get', id),
  createPage: (options) => ipcRenderer.invoke('pages:create', options ?? {}),
  savePage: (page) => ipcRenderer.invoke('pages:save', page),
  deletePage: (id) => ipcRenderer.invoke('pages:delete', id),
  restorePage: (id) => ipcRenderer.invoke('pages:restore', id),
  revealPage: (id) => ipcRenderer.invoke('pages:reveal', id),
  onPagesChanged: (callback) => subscribe('pages:changed', () => {
      callback()
    }),
  openSession: (id) => ipcRenderer.invoke('sessions:open', id),
  editSession: (id, seq, ops) => ipcRenderer.invoke('sessions:edit', id, seq, ops),
  closeSession: (id) => {
    ipcRenderer.send('sessions:close', id)
  },
  onSessionChange: (callback) => subscribe<SessionChangeEvent>('sessions:changed', callback),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  onSettingsChanged: (callback) => subscribe<Settings>('settings:changed', callback),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  moveNotes: () => ipcRenderer.invoke('notes:move'),
  revealNotesFolder: () => ipcRenderer.invoke('notes:reveal'),
  getAppUsage: () => ipcRenderer.invoke('app:usage'),
  exportIgnoredApps: () => ipcRenderer.invoke('prompts:exportIgnored'),
  importIgnoredApps: () => ipcRenderer.invoke('prompts:importIgnored'),
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
  startRecording: (pageId, withSystem) => ipcRenderer.invoke('recorder:start', pageId, withSystem),
  appendRecording: (track, pcm16) => {
    ipcRenderer.send('recorder:append', track, pcm16)
  },
  stopRecording: () => ipcRenderer.invoke('recorder:stop'),
  onTranscriptProgress: (callback) => subscribe<TranscriptProgress>('transcriber:progress', callback),
  onRecorderFailed: (callback) => subscribe<RecorderFailure>('recorder:failed', callback),
  sessionAudio: (pageId, start, end) => ipcRenderer.invoke('sessions:audio', pageId, start, end),
  listPeople: () => ipcRenderer.invoke('people:list'),
  onPeopleChanged: (callback) => subscribe<Person[]>('people:changed', callback),
  enrollPerson: (name, pcm, self) => ipcRenderer.invoke('people:enroll', name, pcm, self),
  renamePerson: (id, name) => ipcRenderer.invoke('people:rename', id, name),
  setSelfPerson: (id) => ipcRenderer.invoke('people:setSelf', id),
  deletePerson: (id) => ipcRenderer.invoke('people:delete', id),
  restorePerson: (id) => ipcRenderer.invoke('people:restore', id),
  resolveSpeaker: (pageId, speakerId, assignment) =>
    ipcRenderer.invoke('meeting:resolveSpeaker', pageId, speakerId, assignment),
  similarLines: (pageId, moved, from) => ipcRenderer.invoke('meeting:similarLines', pageId, moved, from),
  onMeetingStatus: (callback) => subscribe<MeetingStatus>('meeting:status', callback),
  generateNotes: (pageId) => ipcRenderer.invoke('notes:generate', pageId),
  summaryEdited: (pageId) => ipcRenderer.invoke('notes:summaryEdited', pageId),
  notesState: (pageId) => ipcRenderer.invoke('notes:state', pageId),
  notesBackfillStatus: () => ipcRenderer.invoke('notes:backfillStatus'),
  backfillNotes: (kind) => ipcRenderer.invoke('notes:backfill', kind),
  stopBackfillNotes: () => ipcRenderer.invoke('notes:stopBackfill'),
  cancelNotes: (pageId) => ipcRenderer.invoke('notes:cancel', pageId),
  keySource: (provider) => ipcRenderer.invoke('secrets:keySource', provider),
  setKey: (provider, key) => ipcRenderer.invoke('secrets:setKey', provider, key),
  previewRetention: (days) => ipcRenderer.invoke('retention:preview', days),
  detectServers: () => ipcRenderer.invoke('notes:detectServers'),
  listServerModels: (baseUrl) => ipcRenderer.invoke('notes:listModels', baseUrl),
  testNotesWriter: () => ipcRenderer.invoke('notes:testWriter'),
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  revealFolder: (target) => ipcRenderer.invoke('diagnostics:reveal', target),
  cancelModelDownload: (name) => ipcRenderer.invoke('models:cancel', name),
  modelStatus: () => ipcRenderer.invoke('models:status:get'),
  retryModel: (feature) => ipcRenderer.invoke('models:retry', feature),
  onModelStatus: (callback) => subscribe<ModelStatus>('models:status', callback),
  activityList: () => ipcRenderer.invoke('activity:list'),
  onActivity: (callback) => subscribe<ActivityItem[]>('activity:changed', callback),
  activityAct: (id, action) => ipcRenderer.invoke('activity:act', id, action),
  dismissActivity: (id) => ipcRenderer.invoke('activity:dismiss', id),
  markActivitySeen: (ids) => ipcRenderer.invoke('activity:seen', ids),
  permissionStatus: () => ipcRenderer.invoke('permissions:status'),
  openPermissionSettings: (kind) => ipcRenderer.invoke('permissions:openSettings', kind),
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  platform: process.platform,
  arch: process.arch,
  warmUp: () => ipcRenderer.invoke('whisper:warmUp'),
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
