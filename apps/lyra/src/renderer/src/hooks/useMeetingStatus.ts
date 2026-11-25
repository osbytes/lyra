import { useEffect, useState } from 'react'
import type { MeetingStatus } from '../../../shared/types'

/** Latest processing status for `pageId`, cleared a moment after it finishes. */
export function useMeetingStatus(pageId: string | undefined): MeetingStatus | null {
  const [status, setStatus] = useState<MeetingStatus | null>(null)
  useEffect(() => {
    setStatus(null)
    return window.api.onMeetingStatus((next) => {
      if (next.pageId === pageId) setStatus(next)
    })
  }, [pageId])
  useEffect(() => {
    if (status?.state !== 'done') return
    const timer = setTimeout(() => {
      setStatus(null)
    }, 2500)
    return () => {
      clearTimeout(timer)
    }
  }, [status])
  return status
}
