import { monogram, SPEAKER_HUES } from '../lib/speakerTone'
import { cn } from '../lib/utils'

/**
 * How sure the machine is about a speaker: sure (plain), suggested (dashed halo, dotted
 * underline, "?"), or unknown (hollow dashed badge, italic name). Shape and line style first,
 * colour second, so it holds in greyscale and high contrast.
 */
export type Certainty = 'sure' | 'likely' | 'unknown'

/** Slot shapes, so a badge still works with no colour at all. */
const SHAPES = [
  'rounded-full', // circle
  'rounded-xs', // square
  '[clip-path:polygon(50%_4%,100%_92%,0_92%)] pt-[6px] text-[9px]', // triangle
  '[clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)] text-[9px]', // diamond
  '[clip-path:polygon(25%_3%,75%_3%,100%_50%,75%_97%,25%_97%,0_50%)]', // hexagon
  'rounded-[30%]', // squircle
  'rounded-[50%_50%_4px_4px]', // arch
  'rounded-full shadow-[inset_0_0_0_3px_rgb(255_255_255/0.5)] dark:shadow-[inset_0_0_0_3px_rgb(0_0_0/0.35)]' // ringed
] as const

type BadgeProps = {
  name: string
  slot: number
  certainty?: Certainty
  size?: 16 | 20
  className?: string
}

/** The speaker badge: a hue, a shape and a monogram per slot; decorative (the name says who). */
export function SpeakerBadge({ name, slot, certainty = 'sure', size = 20, className }: BadgeProps) {
  const overflow = slot >= SPEAKER_HUES
  const filled = certainty !== 'unknown' && !overflow
  const style = filled ? { background: `var(--speaker-${String((slot % SPEAKER_HUES) + 1)})` } : undefined
  return (
    <span
      aria-hidden="true"
      data-slot="speaker-badge"
      style={style}
      className={cn(
        'relative inline-grid shrink-0 place-items-center leading-none font-semibold',
        size === 20 ? 'size-5 text-[10px]' : 'size-4 text-[8px]',
        certainty === 'unknown'
          ? 'rounded-full border-[1.5px] border-dashed border-text-3 bg-transparent text-text-2'
          : overflow
            ? 'rounded-full bg-surface-3 text-foreground'
            : cn('text-(--speaker-text)', SHAPES[slot % SHAPES.length]),
        certainty === 'likely' && 'outline-[1.5px] outline-offset-[1.5px] outline-suggested outline-dashed',
        className
      )}
    >
      {certainty === 'unknown' && !/^speaker\s+\d+$/i.test(name.trim()) ? '?' : monogram(name)}
    </span>
  )
}

/** Badge and name, as one label. The name never takes the speaker's colour. */
export function SpeakerName({
  name,
  slot,
  certainty = 'sure',
  size = 20,
  className
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap text-foreground',
        className
      )}
    >
      <SpeakerBadge name={name} slot={slot} certainty={certainty} size={size} />
      <span
        className={cn(
          'truncate',
          certainty === 'likely' && 'border-b-[1.5px] border-dotted border-suggested',
          certainty === 'unknown' && 'font-medium text-text-2 italic'
        )}
      >
        {name}
      </span>
      {certainty === 'likely' ? (
        <span className="rounded-full border border-current px-[5px] text-[10.5px] leading-[15px] font-semibold text-suggested">
          ?
        </span>
      ) : null}
    </span>
  )
}
