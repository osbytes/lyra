import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono, Source_Serif_4 } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'

// Self-hosted at build time: the page never asks Google (or anyone else) for fonts.
const inter = Inter({ subsets: ['latin'], variable: '--nf-inter', display: 'swap' })
const serif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  variable: '--nf-serif',
  display: 'swap'
})
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--nf-mono', display: 'swap' })

const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
const DESCRIPTION =
  'Talk, meet, think out loud. Lyra writes it all down: it transcribes on your computer, tells speakers apart, and saves plain text files you own.'

export const metadata: Metadata = {
  metadataBase: new URL(productionHost ? `https://${productionHost}` : 'http://localhost:3100'),
  title: 'Lyra: a local voice notebook',
  description: DESCRIPTION,
  openGraph: { title: 'Lyra', description: DESCRIPTION, type: 'website' }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0f13' }
  ]
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
