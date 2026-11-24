'use client'

// A port of apps/lyra/src/renderer/src/components/Editor.tsx: a textarea layered over a mirror
// of its own text. The mirror sizes the field and draws the transcriber's cursor (and its
// unconfirmed words) where it writes, so the visitor can keep typing anywhere while Lyra writes.
import { useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { appendTranscript, mapPosition } from '@/lib/demo/text'

type Props = {
  value: string
  /** Unconfirmed dictation, drawn where the transcriber will write it. */
  ghost: string
  listening: boolean
  /** The transcriber's cursor in `value`; it writes there, not at the user's caret. */
  transcriberAt?: number | null
  onChange: (value: string) => void
  /** Accessible name; also turns off the "start talking" placeholder for secondary fields. */
  label?: string
  /** Enter leaves the field instead of adding a line (transcript lines). */
  singleLine?: boolean
}

export function Editor({ value, ghost, listening, transcriberAt, onChange, label, singleLine = false }: Props) {
  const area = useRef<HTMLTextAreaElement | null>(null)
  const shown = useRef({ value, start: value.length, end: value.length })

  useLayoutEffect(() => {
    const el = area.current
    const last = shown.current
    if (el && last.value !== value && document.activeElement === el) {
      // Another author wrote: put the visitor's selection back where it was.
      el.setSelectionRange(mapPosition(last.value, value, last.start), mapPosition(last.value, value, last.end))
    }
    shown.current = { value, start: el?.selectionStart ?? last.start, end: el?.selectionEnd ?? last.end }
  }, [value])

  const at = Math.max(0, Math.min(transcriberAt ?? value.length, value.length))
  const before = value.slice(0, at)
  const after = value.slice(at)
  // Unconfirmed words are previewed only at the end; in the middle they'd sit on the text after.
  const atEnd = !after.trim()
  const merged = ghost && atEnd ? appendTranscript(before, ghost) : before
  const preview = merged.startsWith(before) ? merged.slice(before.length) : ''

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (singleLine && event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  return (
    <div className="editor-field">
      <div className="editor-mirror" aria-hidden="true">
        {before}
        <span className="ghost">{preview}</span>
        {listening ? <span className="transcriber-caret" /> : null}
        {after}
        {'​'}
      </div>
      <textarea
        ref={area}
        className="editor"
        value={value}
        rows={singleLine ? 1 : undefined}
        spellCheck={false}
        onChange={(event) => {
          const el = event.target
          shown.current = { value: el.value, start: el.selectionStart, end: el.selectionEnd }
          onChange(singleLine ? el.value.replace(/\n/g, ' ') : el.value)
        }}
        onSelect={(event) => {
          const el = event.currentTarget
          shown.current = { ...shown.current, start: el.selectionStart, end: el.selectionEnd }
        }}
        onKeyDown={onKeyDown}
        placeholder={
          preview || listening || label ? '' : 'Start talking or typing. Your words land here and save automatically.'
        }
        aria-label={label ?? 'Page body'}
      />
    </div>
  )
}
