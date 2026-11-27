import { useEffect, useState } from 'react'
import { formatBytes } from '../../../shared/bytes'
import type { Diagnostics, RevealTarget } from '../../../shared/types'
import { ipcErrorMessage } from '../lib/ipcError'
import { notify } from '../lib/toast'
import { Row, Section } from './SettingsParts'
import { Button } from './ui/button'

/** Settings' About tab icon: an "i" in a circle, drawn like the icons in Icons.tsx. */
export const InfoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)

function backendText(backend: Diagnostics['whisper']['backend']): string {
  switch (backend) {
    case 'gpu':
      return 'Running on the GPU'
    case 'cpu':
      return 'Running on the CPU'
    case null:
      return 'Not used yet since Lyra started'
  }
}

type Load = { state: 'loading' } | { state: 'ready'; info: Diagnostics } | { state: 'error'; message: string }

/** Settings → About: versions, where files live and the room they take, and a copyable report. */
export function AboutSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let alive = true
    window.api.getDiagnostics().then(
      (info) => {
        if (alive) setLoad({ state: 'ready', info })
      },
      (error: unknown) => {
        if (alive) setLoad({ state: 'error', message: ipcErrorMessage(error, 'Couldn’t read the app’s details.') })
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const reveal = (target: RevealTarget): void => {
    window.api.revealFolder(target).catch((error: unknown) => {
      notify(ipcErrorMessage(error, 'Couldn’t open the folder.'))
    })
  }

  if (load.state === 'loading') {
    return (
      <Section title="About Lyra">
        <p className="settings-notice" role="status">
          Reading versions and folder sizes…
        </p>
      </Section>
    )
  }
  if (load.state === 'error') {
    return (
      <Section title="About Lyra">
        <p className="settings-notice is-error">{load.message}</p>
      </Section>
    )
  }
  const { info } = load
  return (
    <>
      <Section title="About Lyra">
        <Row label={`Lyra ${info.version}`} hint={`${info.os} (${info.arch}) · Electron ${info.electron}`}>
          <Button
           
            type="button"
            onClick={() => {
              window.api.copyText(info.text)
              notify('Diagnostics copied')
            }}
          >
            Copy diagnostics
          </Button>
        </Row>
        <p className="settings-notice is-footnote">
          Versions, this computer and its load, folders, sizes and engines only: never your notes, transcripts,
          names or keys.
        </p>
        <Row
          label="This computer"
          hint={`${info.machine.cpu} · ${String(info.machine.cores)} cores · ${String(info.machine.memoryGb)} GB memory`}
        >
          {null}
        </Row>
        <Row label="Transcription" hint={`${info.whisper.model} · ${backendText(info.whisper.backend)}`}>
          {null}
        </Row>
        <Row label="Summaries" hint={info.notesEngine}>
          {null}
        </Row>
      </Section>
      <Section title="Storage on this computer">
        <ul className="settings-places">
          {info.places.map((place) => (
            <li key={place.id}>
              <span className="settings-place-label">{place.label}</span>
              <span className="settings-path" title={place.path}>
                {place.path}
              </span>
              <span className="settings-place-size">
                {formatBytes(place.bytes)}
                {place.complete ? '' : '+'}
              </span>
            </li>
          ))}
        </ul>
        <Row label="Folders" hint="Logs help with a bug report. Models download again if they are removed.">
          <div className="settings-buttons">
            <Button type="button" onClick={() => reveal('logs')}>
              Reveal logs
            </Button>
            <Button type="button" onClick={() => reveal('models')}>
              Reveal models folder
            </Button>
          </div>
        </Row>
      </Section>
    </>
  )
}
