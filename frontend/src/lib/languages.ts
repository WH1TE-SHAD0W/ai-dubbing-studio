export interface Language {
  code: string
  name: string
}

// Static for now; verified against Gemini Live Translate's supported languages (Irish is not one of them).
// This should come from the backend once it exposes the engine's capabilities.
export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English' },
  { code: 'sk', name: 'Slovak' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'pl', name: 'Polish' },
  { code: 'cs', name: 'Czech' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'nl', name: 'Dutch' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ro', name: 'Romanian' },
]

/** Chips shown before "+ More". */
export const QUICK_TARGETS = ['sk', 'de', 'es', 'fr', 'uk', 'pl']

/** HLD default: bounds engine cost per session in the MVP. */
export const MAX_TARGETS = 5

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase()
}

/** Add or remove a target language, never exceeding MAX_TARGETS. */
export function toggleTarget(selected: string[], code: string): string[] {
  if (selected.includes(code)) return selected.filter((c) => c !== code)
  if (selected.length >= MAX_TARGETS) return selected
  return [...selected, code]
}

/** The spoken language can't also be a target. */
export function withoutSpoken(targets: string[], spoken: string): string[] {
  return targets.filter((c) => c !== spoken)
}

/** Which target chips to render: the quick set plus anything already selected, or everything when expanded. */
export function visibleTargets(spoken: string, selected: string[], expanded: boolean): Language[] {
  return LANGUAGES.filter(
    (l) => l.code !== spoken && (expanded || QUICK_TARGETS.includes(l.code) || selected.includes(l.code)),
  )
}
