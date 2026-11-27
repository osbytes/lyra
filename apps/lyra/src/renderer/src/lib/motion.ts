/**
 * How Lyra scrolls to something: instantly, always. A glide to a search hit, a reference or a
 * section is time spent watching the way; the attention outline (`drawAttention`) shows where
 * you landed instead.
 */
export function scrollBehavior(): ScrollBehavior {
  return 'instant'
}

/**
 * Briefly outlines an element the person was just taken to (a search hit, a referenced section,
 * a setting from the launcher), so the eye finds it. Restarts if it's already running.
 */
export function drawAttention(element: Element | null): void {
  if (!element) return
  element.classList.remove('attention')
  // Reading layout restarts the animation when the class goes straight back on.
  element.getBoundingClientRect()
  element.classList.add('attention')
  element.addEventListener('animationend', () => element.classList.remove('attention'), { once: true })
}
