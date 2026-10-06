export interface SessionForm {
  title: string
  targets: string[]
  speakerConsent: boolean
  aiNotice: boolean
}

/** Everything still missing before Start can be enabled, in the order the host should fix it. */
export function startBlockers(f: SessionForm): string[] {
  const out: string[] = []
  if (!f.title.trim()) out.push('Add a session title.')
  if (f.targets.length === 0) out.push('Pick at least one target language.')
  if (!f.speakerConsent) out.push('The speaker must agree to voice cloning.')
  if (!f.aiNotice) out.push('Confirm listeners are told the audio is AI-generated.')
  return out
}

export const canStart = (f: SessionForm): boolean => startBlockers(f).length === 0
