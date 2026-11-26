import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ActionItemsFound, SectionNotes } from './notesFormat'
import { limitNotesSchema } from './notesLimits'

const jsonSchema = (schema: z.ZodObject): Record<string, unknown> => z.toJSONSchema(schema, { target: 'draft-07' })

describe('limitNotesSchema', () => {
  it('bounds the lists and strings of a section answer', () => {
    expect(limitNotesSchema(jsonSchema(SectionNotes))).toMatchObject({
      type: 'object',
      properties: {
        decisions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
        openQuestions: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
        summary: { type: 'string', maxLength: 1200 },
        title: { type: 'string', maxLength: 80 }
      }
    })
  })

  it('bounds the fields inside each action item by their names', () => {
    expect(limitNotesSchema(jsonSchema(ActionItemsFound))).toMatchObject({
      properties: {
        actionItems: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              quote: { type: 'string', maxLength: 200 },
              owner: { type: 'string', maxLength: 40 },
              task: { type: 'string', maxLength: 120 }
            }
          }
        }
      }
    })
  })

  it('keeps limits a schema already has and leaves the input unchanged', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string', maxLength: 50 } } }
    const limited = limitNotesSchema(schema)
    expect(limited).toEqual({ type: 'object', properties: { summary: { type: 'string', maxLength: 50 } } })
    expect(limited).not.toBe(schema)
    expect(schema.properties.summary).toEqual({ type: 'string', maxLength: 50 })
  })

  it('gives an unnamed string field the list-item limit', () => {
    const schema = { type: 'object', properties: { note: { type: 'string' } } }
    expect(limitNotesSchema(schema)).toEqual({
      type: 'object',
      properties: { note: { type: 'string', maxLength: 200 } }
    })
  })
})
