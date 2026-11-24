import { useLayoutEffect, useRef, type Ref } from 'react'
import { appendTranscript } from '../../../shared/transcriptText'

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
  ref?: Ref<HTMLTextAreaElement>
}

/**
 * Where a position lands after `before` became `after` through one contiguous edit (typing,
 * a paste, the transcriber inserting a chunk). Positions before the edit stay put; positions
 * after it move with the text. That keeps the user's caret still while text arrives elsewhere.
 */
export function mapPosition(before: string, after: string, position: number): number {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--
    endAfter--
  }
  if (position <= start) return position
  if (position >= endBefore) return position + (after.length - before.length)
  return endAfter
}

/**
 * A textarea layered over a mirror of its own text. The mirror sizes the field to its content
 * and draws the transcriber's cursor (and its unconfirmed words) where it writes, like a second
 * author in the document. The user's caret stays where they left it when text arrives.
 */
export function Editor({
  value,
  ghost,
  listening,
  transcriberAt,
  onChange,
  label,
  ref
}: Props) {
  const area = useRef<HTMLTextAreaElement | null>(null)
  // What the textarea last showed, and the user's selection in it.
  const shown = useRef({ value, start: value.length, end: value.length })

  useLayoutEffect(() => {
    const el = area.current
    const last = shown.current
    if (el && last.value !== value && document.activeElement === el) {
      // React replaced the text (another author wrote): put the selection back where it was.
      el.setSelectionRange(mapPosition(last.value, value, last.start), mapPosition(last.value, value, last.end))
    }
    shown.current = { value, start: el?.selectionStart ?? last.start, end: el?.selectionEnd ?? last.end }
  }, [value])

  const at = Math.max(0, Math.min(transcriberAt ?? value.length, value.length))
  const before = value.slice(0, at)
  const after = value.slice(at)
  // Unconfirmed words are previewed only at the end: in the middle they would sit on top of the
  // text that follows (the mirror is drawn underneath the textarea).
  const atEnd = !after.trim()
  const merged = ghost && atEnd ? appendTranscript(before, ghost) : before
  const preview = merged.startsWith(before) ? merged.slice(before.length) : ''

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
        ref={(el) => {
          area.current = el
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        className="editor"
        value={value}
        onChange={(event) => {
          const el = event.target
          shown.current = { value: el.value, start: el.selectionStart, end: el.selectionEnd }
          onChange(el.value)
        }}
        onSelect={(event) => {
          const el = event.currentTarget
          shown.current = { ...shown.current, start: el.selectionStart, end: el.selectionEnd }
        }}
        placeholder={
          preview || listening || label
            ? ''
            : 'Start talking or typing. Your words land here and save automatically.'
        }
        aria-label={label ?? 'Page body'}
      />
    </div>
  )
}
