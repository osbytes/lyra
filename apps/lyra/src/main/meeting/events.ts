const labeledListeners = new Set<(pageId: string) => void>()

/** Fires once a recording's transcript has speakers (meeting notes hook in here). */
export function onMeetingLabeled(listener: (pageId: string) => void): () => void {
  labeledListeners.add(listener)
  return () => labeledListeners.delete(listener)
}

export function notifyLabeled(pageId: string): void {
  for (const listener of labeledListeners) listener(pageId)
}
