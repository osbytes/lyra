/** Fewer words than this and a summary has nothing to say ("Testing, hello, hello."). */
export const MIN_SUMMARY_WORDS = 40

/**
 * Whether a finished recording is worth summarizing without being asked: enough was said. A
 * summary asked for by hand is always written; this only gates the automatic one.
 */
export function worthSummarizing(lines: readonly { text: string }[]): boolean {
  let words = 0
  for (const line of lines) {
    words += line.text.split(/\s+/).filter(Boolean).length
    if (words >= MIN_SUMMARY_WORDS) return true
  }
  return false
}
