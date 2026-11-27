import { describe, expect, it } from 'vitest'
import { promptAppFits, promptAppLink, promptAppProbe } from './promptApps'

describe('promptAppLink', () => {
  it('builds each app’s documented prefill link, encoding the text', () => {
    const text = 'Fix this & that?\nThanks'
    const encoded = 'Fix%20this%20%26%20that%3F%0AThanks'
    expect(promptAppLink('claude-code', text).url).toBe(`claude-cli://open?q=${encoded}`)
    expect(promptAppLink('chatgpt', text).url).toBe(`codex://new?prompt=${encoded}`)
    expect(promptAppLink('cursor', text).url).toBe(
      `cursor://anysphere.cursor-deeplink/prompt?text=${encoded}`
    )
    expect(promptAppLink('t3code', text).url).toBe(`t3code://new?prompt=${encoded}`)
    expect(promptAppLink('claude', text).url).toBe(`claude://claude.ai/new?q=${encoded}`)
    expect(promptAppLink('claude-desktop-code', text).url).toBe(`claude://code/new?q=${encoded}`)
    expect(promptAppLink('zed', text).url).toBe(`zed://agent?prompt=${encoded}`)
    expect(promptAppLink('copilot', text).url).toBe(`ghapp://session/new?prompt=${encoded}`)
  })

  it('turns Windows line endings into newlines and trims', () => {
    expect(promptAppLink('claude-code', '  a\r\nb\rc  ')).toEqual({
      url: 'claude-cli://open?q=a%0Ab%0Ac',
      truncated: false
    })
  })

  it('cuts long text at the last word within the limit', () => {
    // 4,000 characters for T3 Code: 999 words of "abc " fill 3,996, then "defgh" crosses it.
    const text = `${'abc '.repeat(999)}defgh ijk`
    const { url, truncated } = promptAppLink('t3code', text)
    expect(truncated).toBe(true)
    expect(decodeURIComponent(url.slice('t3code://new?prompt='.length))).toBe('abc '.repeat(999).trimEnd())
  })

  it('never splits an emoji when one straddles the limit', () => {
    // 3,999 letters then an emoji (two UTF-16 units): the limit falls between its halves.
    const text = `${'a'.repeat(3999)}😀`
    const { url, truncated } = promptAppLink('cursor', text)
    expect(truncated).toBe(true)
    expect(url.endsWith('a')).toBe(true)
  })
})

describe('promptAppFits', () => {
  it('compares the cleaned text with the app’s limit', () => {
    expect(promptAppFits('claude-code', 'x'.repeat(5000))).toBe(true)
    expect(promptAppFits('claude-code', 'x'.repeat(5001))).toBe(false)
    expect(promptAppFits('cursor', ` ${'x'.repeat(4000)} `)).toBe(true)
  })
})

describe('promptAppProbe', () => {
  it('asks the OS about the app’s own scheme', () => {
    expect(promptAppProbe('claude-code')).toBe('claude-cli://')
    expect(promptAppProbe('chatgpt')).toBe('codex://')
  })
})
