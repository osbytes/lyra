import Image, { getImageProps } from 'next/image'
import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { REPO_URL, type Release } from '@/lib/releases'
import { DownloadCards, HeroDownload } from './DownloadLinks'
import { HeroGraph } from './HeroGraph'
import { HeroSky } from './HeroSky'
import { GitHubIcon } from './SiteIcons'
import styles from './site.module.css'

function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={cx(styles.brand, small && styles.brandSmall)}>
      <Image src="/lyra-logo.svg" alt="" width={small ? 22 : 28} height={small ? 22 : 28} className={styles.brandMark} />
      Lyra
    </span>
  )
}

function SectionHead({ eyebrow, id, title, children }: { eyebrow: string; id: string; title: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.secHead}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={id} className={styles.h2}>
        {title}
      </h2>
      <p className={styles.secText}>{children}</p>
    </div>
  )
}

export function Header() {
  return (
    <header className={styles.siteHead}>
      <div className={styles.inner}>
        <a href="#top" className={styles.brandLink}>
          <Brand />
        </a>
        <nav className={styles.nav} aria-label="Sections">
          <a href={REPO_URL}>GitHub</a>
        </nav>
        <a className={cx(styles.btn, styles.btnPrimary, styles.btnSmall)} href="#download">
          Download
        </a>
      </div>
    </header>
  )
}

export function Hero({ release }: { release: Release }) {
  return (
    <section className={styles.hero}>
      <HeroSky />
      <div className={styles.inner}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Voice notebook for macOS, Windows and Linux</p>
          <h1 className={styles.h1}>
            <span className={styles.h1Line}>Talk, meet, think out loud.</span> Lyra{' '}
            <em>writes it all down</em>.
          </h1>
          <div>
            <p className={styles.lede}>
              Dictate a thought or record a whole meeting. Lyra transcribes as you speak, tells speakers apart, and saves
              locally.
            </p>
            <div className={styles.ctas}>
              <HeroDownload release={release} />
              <a className={cx(styles.btn, styles.btnGhost)} href={REPO_URL}>
                Source on GitHub
              </a>
            </div>
          </div>
        </div>
        <HeroGraph />
      </div>
    </section>
  )
}

const SHOT = { width: 2560, height: 1600, sizes: '(max-width: 1200px) 100vw, 1160px' } as const

/** The app itself, in a meeting: the light or dark capture, following the visitor's theme. */
export function AppShot() {
  const alt =
    'Lyra showing a design review: the sessions list, a generated summary with action items, a transcript with each line labeled by speaker, and the details panel with tags and how much each speaker talked'
  const { props: dark } = getImageProps({ ...SHOT, alt, src: '/screenshots/meeting-details-dark.webp' })
  const {
    props: { srcSet: light, ...img }
  } = getImageProps({ ...SHOT, alt, src: '/screenshots/meeting-details-light.webp', loading: 'eager' })
  return (
    <section className={styles.demo} aria-label="Lyra in a meeting">
      <div className={styles.inner}>
        <picture className={styles.shot}>
          <source media="(prefers-color-scheme: dark)" srcSet={dark.srcSet} sizes={SHOT.sizes} />
          <source media="(prefers-color-scheme: light)" srcSet={light} sizes={SHOT.sizes} />
          <img {...img} className={styles.shotImg} />
        </picture>
        <p className={styles.demoCap}>
          A meeting in Lyra: who said what, a summary with action items, and every line kept as it was heard.
        </p>
      </div>
    </section>
  )
}

export function Download({ release }: { release: Release }) {
  return (
    <section className={styles.section} id="download" aria-labelledby="download-h">
      <div className={styles.inner}>
        <SectionHead
          eyebrow="Download"
          id="download-h"
          title={
            <>
              Start a <em>session</em>.
            </>
          }
        >
          Free and open source under the MIT license. Grant microphone access on first launch. On macOS, recording a
          call’s audio also needs Screen Recording permission.
        </SectionHead>
        <DownloadCards release={release} />
        <p className={styles.src}>
          Or build it yourself with Node.js 20+ and pnpm:{' '}
          <code>git clone {REPO_URL}.git &amp;&amp; cd lyra &amp;&amp; pnpm install &amp;&amp; pnpm dev</code>
        </p>
      </div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className={styles.foot}>
      <div className={styles.inner}>
        <Brand small />
        <span>MIT license. Speech by whisper.cpp, speakers by sherpa-onnx, notes by llama.cpp.</span>
        <a className={cx(styles.push, styles.footLink)} href={REPO_URL}>
          <GitHubIcon />
          GitHub
        </a>
      </div>
    </footer>
  )
}
