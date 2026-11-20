import { useEffect, useState, type ReactNode } from 'react'
import type { Settings as SettingsValue } from '../../../shared/types'
import { CloseIcon, FolderIcon } from './Icons'
import { MicrophoneSelect } from './MicrophoneSelect'

type Props = {
  settings: SettingsValue
  update: (patch: Partial<SettingsValue>) => Promise<SettingsValue>
  onClose: () => void
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  )
}

function NotesSection({ settings, update }: Pick<Props, 'settings' | 'update'>) {
  const [notice, setNotice] = useState<string | null>(null)

  const changeFolder = async (): Promise<void> => {
    const picked = await window.api.pickFolder()
    if (!picked || picked === settings.notesDir) return
    const previous = settings.notesDir
    await update({ notesDir: picked })
    if (window.confirm(`Move your existing notes from\n${previous}\ninto\n${picked}?`)) {
      const { moved, skipped } = await window.api.moveNotes(previous)
      setNotice(
        `Moved ${moved} ${moved === 1 ? 'note' : 'notes'}` +
          (skipped ? ` · ${skipped} skipped (same name already there)` : '')
      )
    } else {
      setNotice('Existing notes were left where they were.')
    }
  }

  return (
    <Section title="Notes">
      <Row label="Notes folder" hint="Every note is a file in this folder.">
        <code className="settings-path" title={settings.notesDir}>
          {settings.notesDir}
        </code>
        <div className="settings-buttons">
          <button className="btn" type="button" onClick={() => void changeFolder()}>
            Change…
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => void window.api.revealNotesFolder()}
            title="Open in file manager"
          >
            <FolderIcon />
            Open
          </button>
        </div>
      </Row>
      {notice ? <p className="settings-notice">{notice}</p> : null}
      <Row label="File format" hint="For new notes. Existing .txt and .md files keep working.">
        <select
          className="settings-select"
          value={settings.fileFormat}
          onChange={(event) =>
            void update({ fileFormat: event.target.value as SettingsValue['fileFormat'] })
          }
        >
          <option value="txt">Plain text (.txt)</option>
          <option value="md">Markdown (.md)</option>
        </select>
      </Row>
    </Section>
  )
}

export function SettingsDialog({ settings, update, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>
        <div className="modal-body">
          <NotesSection settings={settings} update={update} />
          <Section title="Microphone">
            <Row label="Input device" hint="Used for dictation and meetings.">
              <MicrophoneSelect
                value={settings.micDeviceId}
                onChange={(micDeviceId) => void update({ micDeviceId })}
              />
            </Row>
          </Section>
        </div>
      </div>
    </div>
  )
}
