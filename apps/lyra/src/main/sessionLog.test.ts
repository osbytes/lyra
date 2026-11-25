import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyLog, frame, readFrames } from './sessionLog'

function logOf(...updates: Uint8Array[]): Buffer {
  return Buffer.concat(updates.map(frame))
}

function edits(): Uint8Array[] {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  doc.getText('notes').insert(0, 'hello')
  doc.getText('notes').insert(5, ' world')
  return updates
}

describe('readFrames', () => {
  it('reads whole frames and reports where they end', () => {
    const bytes = logOf(new Uint8Array([1, 2, 3]), new Uint8Array([4]))
    const { frames, end } = readFrames(bytes)
    expect(frames.map((f) => [...f])).toEqual([[1, 2, 3], [4]])
    expect(end).toBe(bytes.byteLength)
  })

  it('stops before a torn last frame', () => {
    const whole = logOf(new Uint8Array([1, 2, 3]))
    const torn = Buffer.concat([whole, frame(new Uint8Array([9, 9, 9, 9])).subarray(0, 6)])
    const { frames, end } = readFrames(torn)
    expect(frames).toHaveLength(1)
    expect(end).toBe(whole.byteLength)
  })
})

describe('applyLog', () => {
  it('applies a clean log', () => {
    const doc = new Y.Doc()
    const result = applyLog(doc, logOf(...edits()), 'load')
    expect(result).toEqual({ applied: 2, damaged: false })
    expect(doc.getText('notes').toJSON()).toBe('hello world')
  })

  it('keeps what came before a torn tail and says the log needs rewriting', () => {
    const [first = new Uint8Array(), second = new Uint8Array()] = edits()
    const bytes = Buffer.concat([logOf(first), frame(second).subarray(0, 3)])
    const doc = new Y.Doc()
    expect(applyLog(doc, bytes, 'load')).toEqual({ applied: 1, damaged: true })
    expect(doc.getText('notes').toJSON()).toBe('hello')
  })

  it('stops at a frame Yjs cannot read instead of throwing', () => {
    const [first = new Uint8Array(), second = new Uint8Array()] = edits()
    const garbage = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255])
    const doc = new Y.Doc()
    const result = applyLog(doc, logOf(first, garbage, second), 'load')
    expect(result.damaged).toBe(true)
    expect(result.applied).toBe(1)
    expect(doc.getText('notes').toJSON()).toBe('hello')
  })

  it('applies nothing from an empty log', () => {
    expect(applyLog(new Y.Doc(), new Uint8Array(), 'load')).toEqual({ applied: 0, damaged: false })
  })
})
