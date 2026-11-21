import type { VoicePagesApi } from '../shared/types'

declare global {
  // Augmenting the built-in Window requires interface declaration merging.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    api: VoicePagesApi
  }
}

export {}
