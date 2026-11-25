// Reads the task usage block at the top of src/main/tasks/args.ts (the reference for task options
// in docs/CONFIG.md). Kept apart from config-docs.mjs so it can be tested without loading envSpec.

/** Line endings as LF: a Windows checkout may have CRLF files, and the docs are always LF. */
export function toLf(text) {
  return text.replaceAll('\r\n', '\n')
}

/**
 * The lines of the `One-off tasks` doc comment, without the leading ` *   `. Throws when the
 * block is missing, so a reworded comment fails the docs check instead of emptying the section.
 */
export function parseTaskUsage(source) {
  const usage = /\/\*\*\n \* One-off tasks[^\n]*\n \*\n([\s\S]*?) \*\n/.exec(toLf(source))?.[1]
  if (!usage) throw new Error('could not find the task usage block in src/main/tasks/args.ts')
  return usage
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^ \* {3}/, ''))
}
