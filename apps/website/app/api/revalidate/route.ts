import { createHash, timingSafeEqual } from 'node:crypto'
import { revalidateTag } from 'next/cache'
import { RELEASE_CACHE_TAG } from '@/lib/releases'

// release.yml calls this once a release is published, so the download links switch to it now
// instead of when the hour-long cache of GitHub's answer runs out. The only effect is a fresh
// fetch of releases/latest, but it still takes a secret so nobody else can make the site refetch.

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest()

function authorized(header: string | null, secret: string): boolean {
  const token = header?.match(/^Bearer (.+)$/)?.[1]
  // hashing first gives equal lengths, which timingSafeEqual needs
  return token !== undefined && timingSafeEqual(sha256(token), sha256(secret))
}

export function POST(request: Request): Response {
  const secret = process.env.REVALIDATE_SECRET
  if (!secret) return Response.json({ error: 'revalidation is not configured' }, { status: 503 })
  if (!authorized(request.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  // expire now: the next visitor waits for the new release rather than seeing the old one once more
  revalidateTag(RELEASE_CACHE_TAG, { expire: 0 })
  return Response.json({ revalidated: true })
}
