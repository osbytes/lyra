import type { NextConfig } from 'next'

// The site makes no third-party requests: fonts are self-hosted by next/font and the latest
// release is fetched on the server. Next's inline bootstrap scripts need 'unsafe-inline' without
// per-request nonces, which would make every page dynamic.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ')

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // The demo is scripted; the page never needs the microphone or camera.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  headers() {
    // React needs eval in development, so the policy only applies to production builds.
    if (process.env.NODE_ENV !== 'production') return Promise.resolve([])
    return Promise.resolve([{ source: '/(.*)', headers: SECURITY_HEADERS }])
  }
}

export default nextConfig
