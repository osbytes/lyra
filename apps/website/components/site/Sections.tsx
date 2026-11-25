import Image, { getImageProps } from 'next/image'
import type { ReactNode } from 'react'
import { FilesBrowser } from '@/components/demo/FilesBrowser'
import { MeetingCard } from '@/components/demo/MeetingCard'
import { cx } from '@/lib/cx'
import { REPO_URL, type Release } from '@/lib/releases'
import { DownloadCards, HeroDownload } from './DownloadLinks'
import { HeroGraph } from './HeroGraph'
import { Keys } from './Keys'
import { MicIcon, SpeakerIcon } from './SiteIcons'
import styles from './site.module.css'

function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={cx(styles.brand, small && styles.brandSmall)}>
      <Image src="/lyra-icon.png" alt="" width={small ? 22 : 28} height={small ? 22 : 28} className={styles.brandMark} />
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
          <a href="#calls">Calls</a>
          <a href="#files">Files</a>
          <a href="#privacy">Privacy</a>
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
      <div className={styles.inner}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Voice notebook for macOS, Windows and Linux</p>
          <h1 className={styles.h1}>
            Talk onto{' '}
            <em>
              pages
              <svg className={styles.smile} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
                <path d="M2 4 Q50 22 98 4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
              </svg>
            </em>
            .
          </h1>
          <div>
            <p className={styles.lede}>
              Lyra writes down what you say while you say it, entirely on your computer. Keep typing while it listens,
              fix any line, and come back later. Every session is a plain text file in a folder you choose.
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
    'Lyra showing a design review: the sessions list, a generated summary with action items, and a transcript with each line labeled by speaker'
  const { props: dark } = getImageProps({ ...SHOT, alt, src: '/screenshots/app-meeting-dark.webp' })
  const {
    props: { srcSet: light, ...img }
  } = getImageProps({ ...SHOT, alt, src: '/screenshots/app-meeting-light.webp', loading: 'eager' })
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

export function Shortcuts() {
  return (
    <section className={styles.section} aria-labelledby="keys-h">
      <div className={styles.inner}>
        <SectionHead
          eyebrow="Always running"
          id="keys-h"
          title={
            <>
              One keystroke from a <em>new session</em>.
            </>
          }
        >
          Lyra sits in the tray. Start a session from any app, and a small recording pill stays on screen until you
          stop.
        </SectionHead>
        <div className={styles.keysGrid}>
          <div className={styles.kcell}>
            <Keys combo="Mod+Shift+Space" className={styles.keys} />
            <h3>New session, anywhere</h3>
            <p>Opens a fresh page and starts recording, whatever app you’re in.</p>
          </div>
          <div className={styles.kcell}>
            <Keys combo="Shift+Mod+D" className={styles.keys} />
            <h3>Continue a session</h3>
            <p>Adds to the end of the open page. Say “new paragraph” to break.</p>
          </div>
          <div className={styles.kcell}>
            <span className={styles.miniSrc}>
              <MicIcon />
              System mic <span aria-hidden="true">+</span>
              <SpeakerIcon />
              Computer
            </span>
            <h3>Calls included</h3>
            <p>Your mic and your computer’s audio, recorded together. Speakers are labeled when there’s more than one.</p>
          </div>
          <div className={styles.kcell}>
            <span className={styles.miniToast}>
              <span className={styles.pillDot} />
              Teams is using your mic <b>Record</b>
            </span>
            <h3>Mic prompts</h3>
            <p>Optional. When Zoom, Teams or Discord turns on your mic, Lyra offers to record.</p>
          </div>
        </div>
      </div>
    </section>
  )
}

export function Calls() {
  return (
    <section className={cx(styles.section, styles.alt)} id="calls" aria-labelledby="calls-h">
      <div className={styles.inner}>
        <SectionHead
          eyebrow="Calls and meetings"
          id="calls-h"
          title={
            <>
              Knows <em>who</em> said what.
            </>
          }
        >
          Lyra labels each voice, matches the ones you’ve saved, and asks before it guesses. Every line keeps its
          timing, so you can replay it or fix a word.
        </SectionHead>
        <MeetingCard />
        <p className={styles.secFoot}>
          Click “Priya?” to confirm a likely match, name Speaker 3, press ▶ on any line, or edit a word.
        </p>
      </div>
    </section>
  )
}

export function Files() {
  return (
    <section className={styles.section} id="files" aria-labelledby="files-h">
      <div className={styles.inner}>
        <SectionHead
          eyebrow="Your files"
          id="files-h"
          title={
            <>
              Plain text in a folder <em>you</em> choose.
            </>
          }
        >
          Each session exports a .txt or .md file named for the moment it started. Beside it, a .lyra.json file gives
          scripts and agents the speakers, timings, confidence and tags. Audio and edit history stay in a hidden folder.
        </SectionHead>
        <FilesBrowser />
      </div>
    </section>
  )
}

const DOWNLOADS = [
  { name: 'Whisper large-v3-turbo', size: '~575 MB', width: '29%', when: 'On your first recording', optional: false },
  { name: 'Speaker models', size: '~32 MB', width: '1.6%', when: 'The first time a session has more than one voice', optional: false },
  { name: 'Local notes model', size: '~2 GB', width: '100%', when: 'Only if you turn on meeting notes on this computer', optional: true }
]

export function Privacy() {
  return (
    <section className={cx(styles.section, styles.alt)} id="privacy" aria-labelledby="privacy-h">
      <div className={styles.inner}>
        <SectionHead
          eyebrow="Privacy"
          id="privacy-h"
          title={
            <>
              Stays on <em>this</em> computer.
            </>
          }
        >
          Speech recognition, speaker labels and meeting notes all run on your machine, and Lyra collects no usage
          data. The one exception is a feature you have to switch on yourself.
        </SectionHead>
        <div className={styles.privacyGrid}>
          <div className={styles.ledgerWrap}>
            <table className={styles.ledger}>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Leaves your computer</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Audio</td>
                  <td>
                    <span className={styles.tag}>Never</span>
                    <small>
                      Kept here for 30 days so you can replay any line, then deleted. You can keep it forever or delete it
                      right after transcription.
                    </small>
                  </td>
                </tr>
                <tr>
                  <td>Voiceprints</td>
                  <td>
                    <span className={styles.tag}>Never</span>
                    <small>Saved voices are stored and matched locally.</small>
                  </td>
                </tr>
                <tr>
                  <td>Notes and transcripts</td>
                  <td>
                    <span className={styles.tag}>Never</span>
                    <small>Plain files in ~/.lyra, or any folder you pick.</small>
                  </td>
                </tr>
                <tr>
                  <td>Meeting transcript</td>
                  <td>
                    <span className={cx(styles.tag, styles.tagOpt)}>Only if you pick a cloud model for notes</span>
                    <small>
                      Meeting notes are off by default. With a cloud model, the transcript text goes to the provider you
                      pick (Anthropic, OpenAI, Google or your own server) with your own key, kept in the system keychain. Audio and voiceprints are never sent.
                    </small>
                  </td>
                </tr>
                <tr>
                  <td>Usage data</td>
                  <td>
                    <span className={styles.tag}>None collected</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={styles.sizes}>
            <h3>What Lyra downloads</h3>
            <p>Models arrive the first time a feature needs them, drawn here to scale.</p>
            {DOWNLOADS.map((item) => (
              <div key={item.name} className={styles.dsRow}>
                <span className={styles.dsName}>{item.name}</span>
                <span className={styles.dsSize}>{item.size}</span>
                <span className={cx(styles.dsBar, item.optional && styles.dsOptional)}>
                  <i style={{ width: item.width }} />
                </span>
                <span className={styles.dsWhen}>{item.when}</span>
              </div>
            ))}
          </div>
        </div>
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
        <a className={styles.push} href={REPO_URL}>
          GitHub
        </a>
      </div>
    </footer>
  )
}
