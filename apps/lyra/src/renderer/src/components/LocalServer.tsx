import { useState } from 'react'
import type { NotesServer, NotesTestResult } from '../../../shared/types'
import { isLoopbackUrl } from '../../../shared/settings'
import { ipcErrorMessage } from '../lib/ipcError'
import { serverHost, serverPrivacy, type ServerKind } from '../lib/summaryPrivacy'
import { Select } from './Controls'
import { CommitInput, Row, type SectionProps } from './SettingsParts'
import { Button } from './ui/button'

const SERVER_NAMES: Record<NotesServer['kind'], string> = { ollama: 'Ollama', 'lm-studio': 'LM Studio' }

/** Not a model id (ids start with a letter or digit): the Select's "type one in" choice. */
const OTHER_MODEL = '…other'

type Lookup<T> = { state: 'idle' } | { state: 'busy' } | { state: 'done'; value: T } | { state: 'error'; message: string }

/**
 * Settings → Summaries → Local server: a server the user runs (Ollama, LM Studio, llama.cpp…),
 * stored as the OpenAI-compatible provider. Finding servers, listing models and testing each
 * make a request only when their button is clicked.
 */
export function LocalServerSettings({ settings, update }: SectionProps) {
  const baseUrl = settings.cloudBaseUrl
  /** What each address turned out to be; an address nobody has asked about yet is 'unknown'. */
  const [kinds, setKinds] = useState<Record<string, ServerKind>>({})
  const [found, setFound] = useState<Lookup<NotesServer[]>>({ state: 'idle' })
  const [models, setModels] = useState<Lookup<{ url: string; ids: string[] }>>({ state: 'idle' })
  const [typing, setTyping] = useState(false)
  const [test, setTest] = useState<Lookup<NotesTestResult>>({ state: 'idle' })
  const [addressError, setAddressError] = useState<string | null>(null)

  const kind: ServerKind = baseUrl === null ? 'unknown' : (kinds[baseUrl] ?? 'unknown')
  const privacy = serverPrivacy(baseUrl, kind)
  const learn = (url: string, next: ServerKind): void => {
    setKinds((current) => ({ ...current, [url]: next }))
  }

  const chooseServer = (server: NotesServer): void => {
    setTest({ state: 'idle' })
    learn(server.baseUrl, server.kind === 'ollama' ? 'ollama' : 'other')
    if (server.baseUrl !== baseUrl) void update({ cloudBaseUrl: server.baseUrl, cloudModel: null })
  }

  const findServers = async (): Promise<void> => {
    setFound({ state: 'busy' })
    try {
      const servers = await window.api.detectServers()
      setFound({ state: 'done', value: servers })
      for (const server of servers) learn(server.baseUrl, server.kind === 'ollama' ? 'ollama' : 'other')
      // One server and no address yet: there is nothing to choose.
      const [only] = servers
      if (servers.length === 1 && only && baseUrl === null) chooseServer(only)
    } catch (error) {
      setFound({ state: 'error', message: ipcErrorMessage(error, 'Couldn’t look for servers.') })
    }
  }

  const loadModels = async (): Promise<void> => {
    if (baseUrl === null) return
    setModels({ state: 'busy' })
    try {
      const result = await window.api.listServerModels(baseUrl)
      learn(baseUrl, result.kind)
      setModels({ state: 'done', value: { url: baseUrl, ids: result.models } })
      setTyping(result.models.length === 0)
    } catch (error) {
      setModels({ state: 'error', message: ipcErrorMessage(error, 'Couldn’t get the model list.') })
    }
  }

  const runTest = async (): Promise<void> => {
    setTest({ state: 'busy' })
    try {
      const result = await window.api.testNotesWriter()
      if (result.ok && baseUrl !== null && isLoopbackUrl(baseUrl)) {
        learn(baseUrl, result.onDevice ? 'ollama' : 'other')
      }
      setTest({ state: 'done', value: result })
    } catch (error) {
      setTest({ state: 'done', value: { ok: false, error: ipcErrorMessage(error) } })
    }
  }

  const saveAddress = async (next: string | null): Promise<string | null> => {
    const saved = await update({ cloudBaseUrl: next, cloudModel: null })
    // A value the schema refuses isn't saved; say why instead of quietly putting the old one back.
    setAddressError(
      saved.cloudBaseUrl === next
        ? null
        : 'Use a full address like http://127.0.0.1:11434/v1. Plain http:// only works for this computer; use https:// for another one.'
    )
    setModels({ state: 'idle' })
    setTest({ state: 'idle' })
    return saved.cloudBaseUrl
  }

  const listed = models.state === 'done' && models.value.url === baseUrl ? models.value.ids : null
  const model = settings.cloudModel
  const showSelect = listed !== null && listed.length > 0 && !typing
  const modelOptions = [
    ...(model === null ? [{ value: '', label: 'Choose a model' }] : []),
    ...(listed ?? []).map((id) => ({ value: id, label: id })),
    ...(model !== null && !(listed ?? []).includes(model) ? [{ value: model, label: model }] : []),
    { value: OTHER_MODEL, label: 'Type a model name…' }
  ]

  return (
    <>
      <p className={privacy.tone === 'warning' ? 'settings-notice is-warning' : 'settings-notice'}>
        {privacy.text}
      </p>
      <Row
        label="Server address"
        hint="Ollama, LM Studio, llama.cpp or any OpenAI-compatible API. Plain http:// only works for this computer; use https:// for another one."
      >
        <CommitInput
          label="Server address"
          value={baseUrl}
          placeholder="http://127.0.0.1:11434/v1"
          onCommit={saveAddress}
        />
        <Button
         
          type="button"
          disabled={found.state === 'busy'}
          onClick={() => void findServers()}
        >
          {found.state === 'busy' ? 'Looking…' : 'Find servers'}
        </Button>
      </Row>
      {addressError ? (
        <p className="settings-notice is-error" role="alert">
          {addressError}
        </p>
      ) : null}
      {found.state === 'error' ? <p className="settings-notice is-error">{found.message}</p> : null}
      {found.state === 'done' ? (
        found.value.length ? (
          <div className="settings-found" role="status">
            <span>Found on this computer:</span>
            {found.value.map((server) => (
              <Button
                key={server.baseUrl}
               
                type="button"
                aria-pressed={server.baseUrl === baseUrl}
                onClick={() => {
                  chooseServer(server)
                }}
              >
                {SERVER_NAMES[server.kind]} · {serverHost(server.baseUrl)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="settings-notice" role="status">
            No Ollama or LM Studio running on this computer. Start one, or type its address.
          </p>
        )
      ) : null}
      <Row label="Model" hint="The model the server should use, as it names it (e.g. llama3.1:8b).">
        {showSelect ? (
          <Select
            label="Model"
            value={model ?? ''}
            options={modelOptions}
            onChange={(next) => {
              if (next === OTHER_MODEL) setTyping(true)
              else if (next) void update({ cloudModel: next })
            }}
          />
        ) : (
          <CommitInput
            label="Model"
            value={model}
            placeholder="model name"
            onCommit={(cloudModel) => update({ cloudModel }).then((saved) => saved.cloudModel)}
          />
        )}
        <Button
         
          type="button"
          disabled={baseUrl === null || models.state === 'busy'}
          onClick={() => void loadModels()}
        >
          {models.state === 'busy' ? 'Loading…' : 'List models'}
        </Button>
      </Row>
      {models.state === 'error' ? <p className="settings-notice is-error">{models.message}</p> : null}
      {listed?.length === 0 ? (
        <p className="settings-notice" role="status">
          The server has no models yet. Download one with it first (for Ollama: ollama pull llama3.1).
        </p>
      ) : null}
      <Row
        label="Check the connection"
        hint="Sends a two-line sample (not your sessions) and asks for a title."
      >
        <Button
         
          type="button"
          disabled={baseUrl === null || model === null || test.state === 'busy'}
          onClick={() => void runTest()}
        >
          {test.state === 'busy' ? 'Testing…' : 'Test'}
        </Button>
      </Row>
      {test.state === 'done' ? <TestResult result={test.value} /> : null}
      <p className="settings-notice is-footnote">
        Small models can fail to write notes in the shape Lyra needs; if summaries fail, try a
        larger model.
      </p>
    </>
  )
}

export function TestResult({ result }: { result: NotesTestResult }) {
  return result.ok ? (
    <p className="settings-notice is-success" role="status">
      Worked: answered in {(result.ms / 1000).toFixed(1)} s.
    </p>
  ) : (
    <p className="settings-notice is-error" role="alert">
      {result.error}
    </p>
  )
}
