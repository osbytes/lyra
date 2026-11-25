import { describe, expect, it } from 'vitest'
import {
  ModelNameArg,
  parseSettingsPatch,
  PermissionKindArg,
  RetentionDaysArg,
  RevealTargetArg,
  ServerUrlArg
} from './ipcSchemas'

const app = { allowNotesDir: false }

describe('settings patch: vocabulary', () => {
  it('cleans the list and drops a bad one without losing the rest', () => {
    expect(parseSettingsPatch({ vocabulary: [' Acme', 'acme', 'Siobhan'] }, app).patch).toEqual({
      vocabulary: ['Acme', 'Siobhan']
    })
    const { patch, dropped } = parseSettingsPatch({ vocabulary: ['x'.repeat(61)], fileFormat: 'md' }, app)
    expect(patch).toEqual({ fileFormat: 'md' })
    expect(dropped).toEqual(['vocabulary'])
  })
})

describe('Settings tool arguments', () => {
  it('checks retention days as the setting does', () => {
    expect(RetentionDaysArg.parse(7)).toBe(7)
    expect(RetentionDaysArg.parse(null)).toBeNull()
    expect(RetentionDaysArg.safeParse(-1).success).toBe(false)
    expect(RetentionDaysArg.safeParse(1.5).success).toBe(false)
  })

  it('takes plain http only for this computer', () => {
    expect(ServerUrlArg.parse('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(ServerUrlArg.safeParse('http://192.168.1.5:11434/v1').success).toBe(false)
    expect(ServerUrlArg.safeParse('file:///etc/passwd').success).toBe(false)
    expect(ServerUrlArg.safeParse(null).success).toBe(false)
  })

  it('takes a model file name, never a path', () => {
    expect(ModelNameArg.parse('ggml-large-v3-turbo-q5_0.bin')).toBe('ggml-large-v3-turbo-q5_0.bin')
    expect(ModelNameArg.safeParse('../settings.json').success).toBe(false)
    expect(ModelNameArg.safeParse('a/b.bin').success).toBe(false)
  })

  it('names permissions and folders from fixed lists', () => {
    expect(PermissionKindArg.safeParse('camera').success).toBe(false)
    expect(RevealTargetArg.safeParse('/').success).toBe(false)
    expect(RevealTargetArg.parse('logs')).toBe('logs')
  })
})
