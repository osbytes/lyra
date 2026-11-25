import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'

/** The building blocks every Settings section uses; their own module so sections can share them. */

export type Update = (patch: Partial<Settings>) => Promise<Settings>

export type SectionProps = { settings: Settings; update: Update }

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
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

/** A text setting saved when the field loses focus or on Enter, not on every keystroke. */
export function CommitInput({
  value,
  placeholder,
  label,
  onCommit
}: {
  value: string | null
  placeholder: string
  label: string
  /** Resolves to what was saved: a value the settings schema rejects is not kept. */
  onCommit: (next: string | null) => Promise<string | null>
}) {
  const [text, setText] = useState(value ?? '')
  // Undo, or another window, can change the saved value under the field.
  useEffect(() => {
    setText(value ?? '')
  }, [value])
  const commit = (): void => {
    const trimmed = text.trim()
    const next = trimmed ? trimmed : null
    if (next === value) return
    void onCommit(next).then(
      (saved) => {
        setText(saved ?? '')
      },
      () => {
        setText(value ?? '')
      }
    )
  }
  return (
    <input
      className="settings-input"
      value={text}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      aria-label={label}
    />
  )
}
