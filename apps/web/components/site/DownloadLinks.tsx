'use client'

import { cx } from '@/lib/cx'
import { useDesktopOs } from '@/lib/platform'
import { formatSize, type Platform, type Release } from '@/lib/releases'
import { ArrowIcon, DownloadIcon } from './SiteIcons'
import styles from './site.module.css'

const PLATFORMS: readonly { platform: Platform; name: string; formats: string }[] = [
  { platform: 'mac', name: 'macOS', formats: '.dmg · .zip' },
  { platform: 'windows', name: 'Windows', formats: 'Installer (.exe)' },
  { platform: 'linux', name: 'Linux', formats: 'AppImage · .deb' }
]

const nameOf = (platform: Platform): string => PLATFORMS.find((p) => p.platform === platform)?.name ?? 'macOS'

function primaryFor(release: Release, platform: Platform): string {
  return release.assets.find((asset) => asset.platform === platform)?.url ?? release.pageUrl
}

/** The hero's button: the installer for the visitor's OS, or the download section on a phone. */
export function HeroDownload({ release }: { release: Release }) {
  const os = useDesktopOs()
  return (
    <a className={cx(styles.btn, styles.btnPrimary)} href={os ? primaryFor(release, os) : '#download'}>
      <DownloadIcon />
      {os ? `Download for ${nameOf(os)}` : 'Download'}
    </a>
  )
}

/** One card per platform, the visitor's highlighted, linking straight to the installers. */
export function DownloadCards({ release }: { release: Release }) {
  const os = useDesktopOs()
  return (
    <div className={styles.dlGrid}>
      {PLATFORMS.map(({ platform, name, formats }) => {
        const assets = release.assets.filter((asset) => asset.platform === platform)
        const [primary, ...others] = assets
        return (
          <div key={platform} className={cx(styles.dlCard, platform === os && styles.dlYours)}>
            <div className={styles.dlTop}>
              <span className={styles.dlOs}>{name}</span>
              {platform === os ? <span className={styles.chip}>Your system</span> : null}
            </div>
            <span className={styles.dlFmt}>
              {primary ? `${primary.format} · ${formatSize(primary.size)}` : formats}
            </span>
            <a className={styles.dlGo} href={primary?.url ?? release.pageUrl}>
              Download{release.version ? ` ${release.version}` : ''} <ArrowIcon />
            </a>
            {others.length ? (
              <span className={styles.dlOthers}>
                Also:{' '}
                {others.map((asset, i) => (
                  <span key={asset.name}>
                    {i ? ', ' : ''}
                    <a href={asset.url}>{asset.format}</a>
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
