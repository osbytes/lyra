/**
 * Tracks the newest of overlapping async operations. Each one takes a token when it begins and,
 * after every await, checks it is still the newest before touching shared state; an older one
 * that lost the race cleans up after itself instead.
 */
export type Latest = {
  begin: () => number
  isCurrent: (token: number) => boolean
  /** Supersedes whatever is running without starting anything new. */
  cancel: () => void
}

export function latest(): Latest {
  let generation = 0
  return {
    begin: () => ++generation,
    isCurrent: (token) => token === generation,
    cancel: () => {
      generation++
    }
  }
}
