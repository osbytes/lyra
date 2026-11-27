import { useState } from 'react'
import { addTerms, MAX_TERM_CHARS, MAX_TERMS } from '../../../shared/vocabulary'
import { CloseIcon } from './Icons'
import { Row, type SectionProps } from './SettingsParts'
import { tip } from './Tooltip'
import { Button } from './ui/button'

const REFUSED = {
  empty: null,
  duplicate: 'Already on the list.',
  'too-long': `Keep each term under ${String(MAX_TERM_CHARS)} characters.`,
  full: `The list holds ${String(MAX_TERMS)} terms; remove one first.`
} as const

/** Names and jargon Whisper should spell the user's way, as removable chips. */
export function VocabularyEditor({ settings, update }: SectionProps) {
  const terms = settings.vocabulary
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const add = (): void => {
    const result = addTerms(terms, text)
    if (result.status === 'unchanged') {
      setNotice(REFUSED[result.reason])
      if (result.reason !== 'too-long') setText('')
      return
    }
    setNotice(null)
    setText('')
    void update({ vocabulary: result.terms })
  }

  return (
    <>
      <Row
        label="Names and terms"
        hint="People, products and jargon you say often, so transcripts spell them your way. Separate several with commas."
      >
        <input
          className="settings-input"
          value={text}
          maxLength={MAX_TERM_CHARS * 10}
          placeholder="e.g. Kubernetes, Siobhan"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && text.trim()) add()
          }}
          aria-label="Name or term to add"
        />
        <Button type="button" disabled={!text.trim()} onClick={add}>
          Add
        </Button>
      </Row>
      {terms.length ? (
        <ul className="settings-chips is-block" aria-label="Names and terms">
          {terms.map((term) => (
            <li key={term}>
              {term}
              <button
                type="button"
                aria-label={`Remove ${term}`}
                {...tip('Remove')}
                onClick={() => {
                  void update({ vocabulary: terms.filter((entry) => entry !== term) })
                }}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      ) : null}
    </>
  )
}
