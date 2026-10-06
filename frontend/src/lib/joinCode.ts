export const CODE_LENGTH = 6

/** Upper-case, drop anything that isn't a letter or digit, cap at CODE_LENGTH. */
export function normalizeJoinCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH)
}

/** KX74M2 -> KX7-4M2 */
export function formatJoinCode(code: string): string {
  const c = normalizeJoinCode(code)
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c
}

export function isCompleteJoinCode(code: string): boolean {
  return normalizeJoinCode(code).length === CODE_LENGTH
}
