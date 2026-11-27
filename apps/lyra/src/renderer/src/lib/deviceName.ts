/**
 * A microphone's name as a person would say it: without the system's "Default - " prefix or a
 * trailing USB id like "(0c45:6536)". "Default - Microphone (USB Live Camera audio) (0c45:6536)"
 * becomes "Microphone (USB Live Camera audio)".
 */
export function shortDeviceName(label: string): string {
  const short = label
    .replace(/^(default|communications)\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim()
  return short || label
}
