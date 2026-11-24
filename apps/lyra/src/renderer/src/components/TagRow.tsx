import { useMemo, useRef, useState } from 'react'
import { normalizeTag } from '../../../shared/sessionDoc'
import { useContextMenu } from './ContextMenu'
import { CloseIcon, PlusIcon } from './Icons'
import { tip } from './Tooltip'

type Props = {
  tags: string[]
  /** Every tag in use, with how many sessions have it, most used first. */
  known: readonly (readonly [string, number])[]
  onAdd: (tag: string) => void
  onRemove: (tag: string) => void
}

type Suggestion = { tag: string; count: number | null }

/** A session's tags as chips, with an inline picker that suggests tags already in use. */
export function TagRow({ tags, known, onAdd, onRemove }: Props) {
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const menu = useContextMenu()

  const suggestions = useMemo((): Suggestion[] => {
    const needle = normalizeTag(query)
    const out: Suggestion[] = known
      .filter(([tag]) => !tags.includes(tag) && tag.includes(needle))
      .slice(0, 6)
      .map(([tag, count]) => ({ tag, count }))
    if (needle && !tags.includes(needle) && !known.some(([tag]) => tag === needle)) {
      out.push({ tag: needle, count: null })
    }
    return out
  }, [known, query, tags])

  const add = (tag: string): void => {
    if (!normalizeTag(tag)) return
    onAdd(tag)
    setQuery('')
    setActive(0)
  }
  const stop = (): void => {
    setAdding(false)
    setQuery('')
    requestAnimationFrame(() => addButton.current?.focus())
  }

  return (
    <div className="tags" aria-label="Tags">
      {tags.map((tag) => (
        <span
          key={tag}
          className="tag-chip"
          onContextMenu={(event) => {
            menu.open(event, `#${tag}`, [
              { label: 'Copy tag', run: () => window.api.copyText(`#${tag}`) },
              { label: 'Remove tag', icon: <CloseIcon />, danger: true, run: () => onRemove(tag) }
            ])
          }}
        >
          <span className="tag-hash" aria-hidden="true">
            #
          </span>
          {tag}
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            {...tip('Remove tag')}
            onClick={() => onRemove(tag)}
          >
            <CloseIcon />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="tag-combo">
          <input
            ref={input}
            autoFocus
            type="text"
            value={query}
            placeholder="Tag name"
            role="combobox"
            aria-label="Add a tag"
            aria-expanded={suggestions.length > 0}
            aria-controls="tag-suggestions"
            aria-activedescendant={
              suggestions.length ? `tag-suggestion-${String(active)}` : undefined
            }
            onChange={(event) => {
              const value = event.target.value
              // A comma finishes a tag and starts the next.
              if (value.endsWith(',')) add(value.slice(0, -1))
              else {
                setQuery(value)
                setActive(0)
              }
            }}
            onBlur={() => {
              if (!query.trim()) setAdding(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (!suggestions.length) return
                const step = event.key === 'ArrowDown' ? 1 : suggestions.length - 1
                setActive((index) => (index + step) % suggestions.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                add(suggestions[active]?.tag ?? query)
              } else if (event.key === 'Backspace' && !query) {
                const last = tags.at(-1)
                if (last) onRemove(last)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                stop()
              }
            }}
          />
          {suggestions.length ? (
            <ul className="tag-suggestions" id="tag-suggestions" role="listbox" aria-label="Tags">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.tag}
                  id={`tag-suggestion-${String(index)}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    // Keep focus in the input so more tags can follow.
                    event.preventDefault()
                    add(suggestion.tag)
                  }}
                >
                  {suggestion.count === null ? (
                    <span>
                      Create <span className="tag-hash">#</span>
                      {suggestion.tag}
                    </span>
                  ) : (
                    <>
                      <span>
                        <span className="tag-hash">#</span>
                        {suggestion.tag}
                      </span>
                      <span className="tag-count">
                        {suggestion.count} {suggestion.count === 1 ? 'session' : 'sessions'}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </span>
      ) : (
        <button ref={addButton} type="button" className="tag-add" onClick={() => setAdding(true)}>
          <PlusIcon />
          Add tag
        </button>
      )}
      {menu.element}
    </div>
  )
}
