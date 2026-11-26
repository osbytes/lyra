/**
 * Length limits for the local model's grammar. A grammar keeps each token valid JSON but can't
 * make a model finish: a small model that starts repeating itself fills its output cap mid-string
 * and leaves JSON that doesn't parse. With every list and string bounded, the grammar closes the
 * answer within the cap, for English at least. Only the local grammar gets these, not the shared
 * zod schemas: a cloud model's longer answer is still a good answer.
 */

/** The most characters a string field may hold, by its name in the schema. */
const FIELD_CHARS: Readonly<Record<string, number>> = {
  summary: 1200,
  title: 80,
  quote: 200,
  owner: 40,
  task: 120
}
/** A string in a list (a decision, an open question). */
const ITEM_CHARS = 200
const ITEMS: Readonly<Record<string, number>> = { actionItems: 12 }
/** Decisions and open questions: more than this from one call is a model repeating itself. */
const LIST_ITEMS = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One schema node, bounded; `name` is the property it sits under, `inList` if it's a list's item. */
function limitNode(node: unknown, name: string | null, inList: boolean): unknown {
  if (!isRecord(node)) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([prop, child]) => [prop, limitNode(child, prop, false)]))
    } else if (key === 'items') {
      out[key] = limitNode(value, name, true)
    } else {
      out[key] = value
    }
  }
  if (node.type === 'array' && node.maxItems === undefined) {
    out.maxItems = (name === null ? undefined : ITEMS[name]) ?? LIST_ITEMS
  }
  if (node.type === 'string' && node.maxLength === undefined) {
    out.maxLength = inList ? ITEM_CHARS : ((name === null ? undefined : FIELD_CHARS[name]) ?? ITEM_CHARS)
  }
  return out
}

/** A copy of a JSON Schema with every array and string bounded (limits it already has stay). */
export function limitNotesSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const limited = limitNode(schema, null, false)
  return isRecord(limited) ? limited : schema
}
