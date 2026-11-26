import { config } from './config'
import { createMeetingNotes, type MeetingNotesService } from './meeting/notes'
import { createLocalNotesWriter } from './meeting/notesLocal'
import { createTitleSuggestions, type TitleService } from './meeting/title'
import { chooseWriter } from './meeting/writers'
import { getApiKey } from './secrets'
import { getSettings } from './settings'

/** The services that take their dependencies explicitly, built in one place at startup. */
export type Services = {
  notes: MeetingNotesService
  titles: TitleService
}

export function createServices(): Services {
  const local = createLocalNotesWriter()
  // Chosen per call, so a change in Settings applies to the next summary without a restart.
  const writer = () => chooseWriter({ settings: getSettings, apiKey: getApiKey, baseUrls: config().baseUrls, local })
  const titles = createTitleSuggestions({ writer })
  return {
    // A finished summary knows the whole session, so the title is suggested again from it.
    notes: createMeetingNotes({ writer, onWritten: (pageId, summary) => void titles.suggestTitle(pageId, { summary }) }),
    titles
  }
}
