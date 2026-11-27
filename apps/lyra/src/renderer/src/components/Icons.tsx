import type { ReactNode, SVGProps } from 'react'

/**
 * Lyra's icon set (the interface system's Iconography): one 16 px set on a 16-unit grid, 1.5 px
 * stroke, round joins. Filled glyphs are reserved for record (solid dot) and stop (solid square).
 * Status icons differ by shape: triangle = warning, octagon = error, circle = info, dashed
 * circle = low confidence, open arc = processing. Icons are decorative (`aria-hidden`); the
 * control around them carries the name.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ children, size = 16, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4l3.6 3.6" />
  </Icon>
)

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 4.5h10.5M6 4.5V2.75h4V4.5M4.25 4.5l.65 9h6.2l.65-9" />
  </Icon>
)

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
    <path d="M3 10.5V3.25c0-.55.45-1 1-1h6.75" />
  </Icon>
)

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8.5l3.25 3.25L13 5" />
  </Icon>
)

export const MicIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" />
  </Icon>
)

/** Preferences: three sliders. */
export const GearIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    <circle cx="5.5" cy="4" r="1.5" fill="var(--surface)" />
    <circle cx="10.5" cy="8" r="1.5" fill="var(--surface)" />
    <circle cx="6.5" cy="12" r="1.5" fill="var(--surface)" />
  </Icon>
)

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
)

export const FolderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.75 4V12.75h12.5V5.5H8L6.5 3.25H2.5a.75.75 0 0 0-.75.75z" />
  </Icon>
)

export const MicSmallIcon = (props: IconProps) => <MicIcon size={14} {...props} />

/** Record, idle: a hollow ring in recording red is drawn by the caller's colour. */
export const RecordIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5" strokeWidth="1.75" />
  </Icon>
)

/** Record, listening or about to: the solid dot. */
export const RecordDotIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" />
  </Icon>
)

/** Activity: a pulse line. */
export const GaugeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.5 8.25h2.75l2-5 3.5 9.5 2-4.5h2.75" />
  </Icon>
)

/** People and saved voices. */
export const PeopleIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="5" cy="5.5" r="2" />
    <circle cx="11" cy="5.5" r="2" />
    <path d="M1.5 13c.4-2.2 1.8-3.4 3.5-3.4s3.1 1.2 3.5 3.4M7.5 13c.4-2.2 1.8-3.4 3.5-3.4s3.1 1.2 3.5 3.4" />
  </Icon>
)

export const SortIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 2.75v10.5M2.75 11 5 13.25 7.25 11M11 13.25V2.75M8.75 5 11 2.75 13.25 5" />
  </Icon>
)

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 6.25 8 9.75l3.5-3.5" />
  </Icon>
)

export const ChevronUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 9.75 8 6.25l3.5 3.5" />
  </Icon>
)

/** Moving the playhead to a time: an arrow up to a bar. */
export const JumpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 8h8M8 5.25 10.75 8 8 10.75M13.25 3v10" />
  </Icon>
)

/** One speaker becoming two: a fork. */
export const SplitIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 13.75V8.75L3.5 3.25M8 8.75l4.5-5.5M3.25 6.25v-3h3M12.75 6.25v-3h-3" />
  </Icon>
)

/** Putting other words in place of what was heard: two opposed arrows. */
export const ReplaceIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 5.5h10.5L10.5 2.75M13.25 10.5H2.75l2.75 2.75" />
  </Icon>
)

/** Removing words from a transcript, kept struck through: a struck-out letter. */
export const StrikeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 8h11M11 4.75C10.6 3.5 9.4 2.75 8 2.75c-1.8 0-3 .95-3 2.3 0 .95.6 1.6 1.75 2" />
    <path d="M5 11.1c.35 1.35 1.55 2.15 3.1 2.15 1.9 0 3.15-.95 3.15-2.4 0-.4-.1-.75-.3-1.05" />
  </Icon>
)

/** Clearing marks off: an eraser. */
export const EraserIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.5 13.25h6.75M2.95 9.55l6.5-6.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-6.2 6.2H5.5L2.95 10.7a.8.8 0 0 1 0-1.15ZM5.75 6.75l3.5 3.5" />
  </Icon>
)

/** Sending text out to another app: a paper plane. */
export const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.25 1.75 7 9M14.25 1.75 9.75 14.25 7 9 1.75 6.25l12.5-4.5Z" />
  </Icon>
)

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.25 4.5 9.75 8l-3.5 3.5" />
  </Icon>
)

/** Computer audio: a screen with a level inside it. */
export const SpeakerIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="1.75" y="2.25" width="12.5" height="9" rx="1.5" />
    <path d="M5.5 14.25h5M5.5 6.75v1M7.25 5.25v4M9 4.5v5.5M10.75 6v2.5" />
  </Icon>
)

export const PanelIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M10.25 2.75v10.5" />
  </Icon>
)

export const SidebarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
    <path d="M5.75 2.75v10.5" />
  </Icon>
)

export const TagIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.25 2.25h5.3l6.2 6.2-5.3 5.3-6.2-6.2z" />
    <circle cx="5.25" cy="5.25" r=".9" fill="currentColor" />
  </Icon>
)

/** A session: a page with lines. */
export const NoteIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.25 1.75h6.5l3 3v9.5h-9.5z" />
    <path d="M9.5 1.75v3.25h3.25M5.5 8.5h5M5.5 11h3.5" />
  </Icon>
)

export const QuoteIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.25 2.75h11.5v8H6.5l-4.25 3z" />
    <path d="M5 5.75h6M5 8h3.75" />
  </Icon>
)

/** The command launcher. */
export const CommandIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3" />
    <path d="M5 6l2 2-2 2M8.75 10.25h2.5" />
  </Icon>
)

export const PlayIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 3.25v9.5l7.5-4.75z" fill="currentColor" stroke="none" />
  </Icon>
)

export const PauseIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="3.25" width="2.75" height="9.5" rx=".75" fill="currentColor" stroke="none" />
    <rect x="9.25" y="3.25" width="2.75" height="9.5" rx=".75" fill="currentColor" stroke="none" />
  </Icon>
)

export const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
  </Icon>
)

export const GripIcon = (props: IconProps) => (
  <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true" fill="currentColor" {...props}>
    <circle cx="2.5" cy="3" r="1.25" />
    <circle cx="7.5" cy="3" r="1.25" />
    <circle cx="2.5" cy="8" r="1.25" />
    <circle cx="7.5" cy="8" r="1.25" />
    <circle cx="2.5" cy="13" r="1.25" />
    <circle cx="7.5" cy="13" r="1.25" />
  </svg>
)

/* The rest of the spec's set: provenance, state, and editing marks. */

/** Made on this computer. */
export const LocalIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2.75" y="2.75" width="10.5" height="7.5" rx="1.25" />
    <path d="M1.25 13.25h13.5M6 6.6l1.4 1.4L10 5.4" />
  </Icon>
)

/** Sent to a named cloud provider. */
export const CloudIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.6 12.75h6.9a3 3 0 0 0 .35-5.98 4 4 0 0 0-7.6.4A2.8 2.8 0 0 0 4.6 12.75z" />
  </Icon>
)

export const WarningIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 1.9l6.6 11.6H1.4z" />
    <path d="M8 6.25v3.25" />
    <circle cx="8" cy="11.6" r=".3" fill="currentColor" />
  </Icon>
)

export const ErrorIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.4 1.75h5.2l3.65 3.65v5.2l-3.65 3.65H5.4L1.75 10.6V5.4z" />
    <path d="M8 4.75v3.75" />
    <circle cx="8" cy="11" r=".3" fill="currentColor" />
  </Icon>
)

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4" />
    <circle cx="8" cy="4.9" r=".3" fill="currentColor" />
  </Icon>
)

/** Still processing: an open arc. */
export const ProcessingIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 1.75a6.25 6.25 0 1 1-6.25 6.25" />
    <circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none" />
  </Icon>
)

/** Outdated, or refresh. */
export const OutdatedIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13.25 6A5.5 5.5 0 0 0 3.1 5.4M2.75 10a5.5 5.5 0 0 0 10.15.6M13.25 2.5V6h-3.5M2.75 13.5V10h3.5" />
  </Icon>
)

/** A speaker needs a name. */
export const NeedsNameIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6.5" cy="5.25" r="2.5" />
    <path d="M1.75 14c.5-2.7 2.4-4.1 4.75-4.1 1 0 1.9.25 2.6.7M11.2 9.2a1.6 1.6 0 1 1 2.2 1.5c-.45.2-.65.5-.65.95v.25" />
    <circle cx="12.75" cy="14" r=".2" fill="currentColor" />
  </Icon>
)

/** Low confidence: a dashed circle with a question mark. */
export const LowConfidenceIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6.25" strokeDasharray="2.2 2" />
    <path d="M6.4 6.3a1.65 1.65 0 1 1 2.3 1.5c-.5.22-.7.55-.7 1.05v.3" />
    <circle cx="8" cy="11.25" r=".25" fill="currentColor" />
  </Icon>
)

export const PersonIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="5.25" r="2.75" />
    <path d="M2.75 14.25c.6-2.9 2.7-4.4 5.25-4.4s4.65 1.5 5.25 4.4" />
  </Icon>
)

export const EditIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M10.5 2.5l3 3-7.75 7.75H2.75v-3z" />
  </Icon>
)

export const RestoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 8a5.25 5.25 0 1 0 1.55-3.7M2.5 2.25v3.1h3.1" />
    <path d="M8 5.5V8l1.75 1.25" />
  </Icon>
)

export const HighlightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.75 2.25l4 4-6.25 6.25h-4v-4zM2 14.5h12" />
  </Icon>
)

export const RevealIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9.25 2.25h4.5v4.5M13.75 2.25 7.5 8.5M11.75 9.5v4.25h-9.5v-9.5H6.5" />
  </Icon>
)

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="3.5" cy="8" r=".9" fill="currentColor" />
    <circle cx="8" cy="8" r=".9" fill="currentColor" />
    <circle cx="12.5" cy="8" r=".9" fill="currentColor" />
  </Icon>
)

export const SummaryIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.75 3.75h10.5M2.75 6.75h10.5M2.75 9.75h5.5M9.75 12l1.6 1.6 3-3" />
  </Icon>
)

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 1.5l5 2v4.1c0 3.1-2.1 5.5-5 6.9-2.9-1.4-5-3.8-5-6.9V3.5z" />
  </Icon>
)

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2.25v8.25M4.5 7l3.5 3.5L11.5 7M2.75 13.75h10.5" />
  </Icon>
)

export const LinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
  </Icon>
)

/** The app's mark: four strings of uneven length, a lyre read as a level meter. */
export const LyraIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4.5v7M6.67 2.5v11M9.33 5v6M12 6.5v3" strokeWidth="1.75" />
  </Icon>
)

/** A table of contents. */
export const ListIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8" />
    <circle cx="2.75" cy="4" r=".75" fill="currentColor" stroke="none" />
    <circle cx="2.75" cy="8" r=".75" fill="currentColor" stroke="none" />
    <circle cx="2.75" cy="12" r=".75" fill="currentColor" stroke="none" />
  </Icon>
)

export const HomeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.25 7.25 8 2.5l5.75 4.75M3.75 6.25v7.5h8.5v-7.5M6.5 13.75v-4h3v4" />
  </Icon>
)
