import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * The interface system's type sizes (app.css `--text-*`). tailwind-merge has to know them as
 * sizes, or it reads `text-label` as a colour and drops it next to `text-text-3`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['caps', 'label', 'body-sm', 'body', 'transcript', 'read', 'title-2', 'title-1', 'display']
    }
  }
})

/** Joins class names, letting a later Tailwind utility win over an earlier one it conflicts with. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
