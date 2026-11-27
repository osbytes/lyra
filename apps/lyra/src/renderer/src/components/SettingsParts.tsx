import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { cn } from '../lib/utils'

/** The building blocks every Settings section uses; their own module so sections can share them. */

export type Update = (patch: Partial<Settings>) => Promise<Settings>

export type SectionProps = { settings: Settings; update: Update }

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section mb-6 grid gap-2" data-section={title}>
      <h3 className="m-0 text-caps font-semibold tracking-[0.06em] text-text-3 uppercase">{title}</h3>
      <div className="settings-card rounded-lg border-(length:--border-width) border-border bg-card px-3.5">{children}</div>
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0">
      <div className="settings-label grid min-w-[180px] flex-1 gap-0.5">
        <span className="text-body text-foreground">{label}</span>
        {hint ? <small className="text-label text-text-3">{hint}</small> : null}
      </div>
      <div className="settings-control flex max-w-full min-w-0 items-center gap-2">{children}</div>
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
      className={cn(
        'settings-input h-8 w-[280px] max-w-full min-w-0 rounded-sm border-(length:--border-width) border-input bg-card px-2.5 text-body text-foreground',
        'placeholder:text-text-3 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring'
      )}
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
