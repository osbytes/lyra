import type { ReactNode, SVGProps } from 'react'

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const SearchIcon = () => (
  <Icon width="14" height="14">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
)

export const TrashIcon = () => (
  <Icon width="14" height="14">
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </Icon>
)

export const CopyIcon = () => (
  <Icon width="15" height="15">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
)

export const CheckIcon = () => (
  <Icon width="15" height="15">
    <path d="m5 12 5 5 9-10" />
  </Icon>
)

export const MicIcon = () => (
  <Icon width="22" height="22" strokeWidth="2">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
)

export const GearIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
)

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const FolderIcon = () => (
  <Icon width="15" height="15">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
)

export const MicSmallIcon = () => (
  <Icon width="15" height="15">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Icon>
)

export const RecordIcon = () => (
  <Icon width="15" height="15">
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </Icon>
)

export const PeopleIcon = () => (
  <Icon width="15" height="15">
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5M15.5 4.5a3.5 3.5 0 0 1 0 7M18 15.2c1.8.6 3 2.2 3.5 4.8" />
  </Icon>
)

export const ChevronDownIcon = () => (
  <Icon width="14" height="14">
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

export const ChevronUpIcon = () => (
  <Icon width="14" height="14">
    <path d="m6 15 6-6 6 6" />
  </Icon>
)

export const SpeakerIcon = () => (
  <Icon width="15" height="15">
    <path d="M4 9v6h4l5 4V5L8 9z" />
    <path d="M17 8.5a5 5 0 0 1 0 7" />
  </Icon>
)

export const PanelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
)

export const TagIcon = () => (
  <Icon width="14" height="14">
    <path d="M3 12V4h8l10 10-8 8z" />
    <circle cx="7.5" cy="8.5" r="1.2" fill="currentColor" />
  </Icon>
)

export const NoteIcon = () => (
  <Icon>
    <path d="M7 3h7l5 5v13H7z" />
    <path d="M14 3v5h5M10 13h6M10 17h4" />
  </Icon>
)

export const QuoteIcon = () => (
  <Icon>
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12h5" />
  </Icon>
)

export const CommandIcon = () => (
  <Icon>
    <path d="m5 7 5 5-5 5M12 17h7" />
  </Icon>
)

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
)

export const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" />
  </svg>
)

export const GripIcon = () => (
  <svg viewBox="0 0 10 16" width="8" height="14" aria-hidden="true" fill="currentColor">
    <circle cx="2.5" cy="3" r="1.25" />
    <circle cx="7.5" cy="3" r="1.25" />
    <circle cx="2.5" cy="8" r="1.25" />
    <circle cx="7.5" cy="8" r="1.25" />
    <circle cx="2.5" cy="13" r="1.25" />
    <circle cx="7.5" cy="13" r="1.25" />
  </svg>
)
