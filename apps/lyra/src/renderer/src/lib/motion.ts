/**
 * Scroll behaviour that respects the system's Reduce motion setting: smooth scrolling is
 * animation, so it becomes an instant jump when the user asked for less motion.
 */
export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
