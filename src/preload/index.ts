import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type {
  Page,
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
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  onSettingsChanged: (callback) => subscribe<Settings>('settings:changed', callback),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  moveNotes: (fromDir) => ipcRenderer.invoke('notes:move', fromDir),
  revealNotesFolder: () => ipcRenderer.invoke('notes:reveal'),
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
