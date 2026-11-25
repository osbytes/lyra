import { useLayoutEffect, useRef, type Ref } from 'react'

type Props = {
  value: string
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
 * A textarea layered over a mirror of its own text; the mirror sizes the field to its content.
 * The user's caret stays where they left it when text arrives from elsewhere.
 */
export function Editor({ value, onChange, label, ref }: Props) {
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

  return (
    <div className="editor-field">
      <div className="editor-mirror" aria-hidden="true">
        {value}
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
        placeholder={label ? '' : 'Start talking or typing. Your words land here and save automatically.'}
        aria-label={label ?? 'Page body'}
      />
    </div>
  )
}
