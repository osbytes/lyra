import { describe, expect, it } from 'vitest'
import { classifyMicUser, meetingFromTitles } from './meetingApps'

/** A mic user as one word: the meeting id, or the kind. */
function kindOf(name: string): string {
  const found = classifyMicUser(name)
  return found.kind === 'meeting' ? found.meeting.id : found.kind
}

describe('classifyMicUser', () => {
  it('knows call apps by exe name, package name and bundle id, in any case', () => {
    expect(kindOf('Zoom')).toBe('zoom')
    expect(kindOf('us.zoom.xos')).toBe('zoom')
    expect(kindOf('MSTeams')).toBe('teams')
    expect(kindOf('91750D7E.Slack')).toBe('slack')
    expect(kindOf('com.apple.FaceTime')).toBe('facetime')
  })

  it('gives the label as well as the id', () => {
    expect(classifyMicUser('ms-teams')).toEqual({
      kind: 'meeting',
      meeting: { id: 'teams', label: 'Microsoft Teams' }
    })
  })

  it('tells browsers and known non-calls apart from everything else', () => {
    expect(kindOf('chrome')).toBe('browser')
    expect(kindOf('com.apple.Safari')).toBe('browser')
    expect(kindOf('obs64')).toBe('not-call')
    expect(kindOf('Streamlabs OBS')).toBe('not-call')
    expect(kindOf('Element')).toBe('other')
    expect(kindOf('')).toBe('other')
  })

  it('matches a whole name or a dotted suffix, not a substring', () => {
    expect(kindOf('notzoom')).toBe('other')
    expect(kindOf('zoomit')).toBe('other')
    expect(kindOf('chromeless')).toBe('other')
  })
})

describe('meetingFromTitles', () => {
  it('finds a meeting site in a browser window title', () => {
    expect(meetingFromTitles(['Meet - abc-defg-hij - Google Chrome'])?.id).toBe('meet')
    expect(meetingFromTitles(['Zoom Meeting - Personal - Microsoft Edge'])?.id).toBe('zoom')
    expect(meetingFromTitles(['  Zoom  '])?.id).toBe('zoom')
    expect(meetingFromTitles(['Weekly sync | Microsoft Teams'])?.id).toBe('teams')
    expect(meetingFromTitles(['Jitsi Meet - Brave'])?.id).toBe('jitsi')
  })

  it('takes the first window that shows a meeting', () => {
    expect(meetingFromTitles(['Inbox (3) - Gmail', 'Meet - xyz - Brave'])).toEqual({
      id: 'meet',
      label: 'Google Meet'
    })
  })

  it('ignores pages that only mention a meeting word', () => {
    expect(meetingFromTitles([])).toBeNull()
    expect(meetingFromTitles(['Zoom lens review - YouTube - Google Chrome'])).toBeNull()
    expect(meetingFromTitles(['Zoom in on photos - Help'])).toBeNull()
    expect(meetingFromTitles(['Meeting notes - Google Docs'])).toBeNull()
    expect(meetingFromTitles(['Meetup: Rust Berlin - Firefox'])).toBeNull()
  })

  it('does not take a search for "zoom" for a Zoom call', () => {
    expect(meetingFromTitles(['zoom - Google Search - Google Chrome'])).toBeNull()
  })

  it('does not take a search for "meet" for a Google Meet call', () => {
    expect(meetingFromTitles(['meet - Google Search - Google Chrome'])).toBeNull()
  })

  it('does not take an article about slack for a Slack huddle', () => {
    expect(meetingFromTitles(['How to cut yourself some slack - Medium - Firefox'])).toBeNull()
  })
})
