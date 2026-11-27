/** Space kept between a popover and its anchor, and between a popover and the window's edge. */
const GAP = 8
const MARGIN = 8

type Box = { width: number; height: number }

/**
 * Where a popover goes next to the thing it's about: below it, else above it, else as low as the
 * window allows. Always fully inside the window, so every row and button in it can be reached
 * (the popover's own max height is the window less the margins, so the last case always fits).
 */
export function placeNear(
  anchor: { top: number; bottom: number; left: number },
  size: Box,
  view: Box
): { top: number; left: number } {
  const left = Math.max(MARGIN, Math.min(anchor.left, view.width - MARGIN - size.width))
  const below = anchor.bottom + GAP
  if (below + size.height <= view.height - MARGIN) return { top: below, left }
  const above = anchor.top - GAP - size.height
  if (above >= MARGIN) return { top: above, left }
  return { top: Math.max(MARGIN, view.height - MARGIN - size.height), left }
}
