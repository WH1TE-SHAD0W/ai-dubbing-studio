import { randomBytes } from 'node:crypto'

export interface Config {
  port: number
  geminiApiKey: string
  geminiModel: string
  hostEmail: string
  hostPassword: string
  hostName: string
  /** Signs the login cookie. Generated at boot when unset, so a restart signs everyone out. */
  sessionSecret: string
  maxSessionMinutes: number
  /** A live session with no host connected for this long is ended (stops Gemini spend). */
  hostGraceMs: number
  /** Cap on target languages per session; each one is a separate paid Gemini stream. */
  maxTargets: number
  /** pino level: 'info' (default) or 'debug' for per-message Gemini traces and 5 s session reports. */
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const need = (key: string): string => {
    const v = env[key]
    if (!v) throw new Error(`${key} is required`)
    return v
  }
  const num = (key: string, fallback: number): number => {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`)
    return n
  }
  return {
    port: num('PORT', 8000),
    geminiApiKey: need('GEMINI_API_KEY'),
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-live-translate-preview',
    hostEmail: need('HOST_EMAIL'),
    hostPassword: need('HOST_PASSWORD'),
    hostName: env.HOST_NAME || 'Host',
    sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    maxSessionMinutes: num('MAX_SESSION_MINUTES', 240),
    hostGraceMs: num('HOST_GRACE_SECONDS', 60) * 1000,
    maxTargets: num('MAX_TARGET_LANGUAGES', 5),
    logLevel: env.LOG_LEVEL || 'info',
  }
}
