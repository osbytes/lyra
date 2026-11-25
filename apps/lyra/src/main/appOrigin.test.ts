import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAppPage } from './appOrigin'

const rendererFile = process.platform === 'win32' ? 'C:\\Apps\\Lyra\\resources\\app.asar\\out\\renderer\\index.html' : '/Applications/Lyra.app/Contents/Resources/app.asar/out/renderer/index.html'
const page = pathToFileURL(rendererFile).href

describe('isAppPage', () => {
  const packaged = { rendererFile, devUrl: null }
  const dev = { rendererFile, devUrl: 'http://localhost:5173' }

  it('accepts the bundled page, with or without a hash', () => {
    expect(isAppPage(page, packaged)).toBe(true)
    expect(isAppPage(`${page}#overlay`, packaged)).toBe(true)
  })

  it('refuses other files and other sites', () => {
    expect(isAppPage(page.replace('index.html', 'other.html'), packaged)).toBe(false)
    expect(isAppPage('file:///tmp/index.html', packaged)).toBe(false)
    expect(isAppPage('https://example.com/', packaged)).toBe(false)
    expect(isAppPage('http://localhost:5173/', packaged)).toBe(false)
    expect(isAppPage('not a url', packaged)).toBe(false)
    expect(isAppPage('', packaged)).toBe(false)
  })

  it('accepts the dev server only in development, by origin', () => {
    expect(isAppPage('http://localhost:5173/#overlay', dev)).toBe(true)
    expect(isAppPage('http://localhost:5174/', dev)).toBe(false)
    expect(isAppPage('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isAppPage(page, dev)).toBe(true)
  })
})
