import { remove } from '../lib/storage'
import {
  type CreateSessionRequest,
  type CreatedSession,
  type JoinInfo,
  type StartedSession,
} from './types'

/** status 0 means the request never got an answer (network down, backend not running). */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export const isUnreachable = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504)

/** A message safe to show a user. */
export function describeError(e: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (isUnreachable(e)) return 'Can’t reach the backend. Check that the server is running.'
  if (e instanceof ApiError && e.status === 429) return 'Too many attempts. Wait a moment and try again.'
  return e instanceof ApiError && e.message ? e.message : fallback
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const h = new Headers(headers)
  if (json !== undefined) h.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...rest,
      headers: h,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'Network error')
  }

  if (res.status === 401 && !path.startsWith('/auth/')) {
    // The login cookie expired or the backend restarted: back to sign-in.
    remove('ads.host')
    window.location.assign('/signin')
  }

  if (!res.ok) {
    let message = ''
    try {
      message = ((await res.json()) as { message?: string }).message ?? ''
    } catch {
      /* non-JSON error body (for example an nginx 502 page) */
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T

  try {
    return (await res.json()) as T
  } catch {
    // A 200 that isn't JSON usually means we hit the static site, not the API.
    throw new ApiError(502, 'Unexpected response from the server')
  }
}

export const api = {
  signIn(email: string, password: string) {
    return request<{ name: string }>('/auth/signin', { method: 'POST', json: { email, password } })
  },
  signOut() {
    return request<void>('/auth/signout', { method: 'POST' })
  },
  createSession(body: CreateSessionRequest) {
    return request<CreatedSession>('/sessions', { method: 'POST', json: body })
  },
  startSession(id: string) {
    return request<StartedSession>(`/sessions/${encodeURIComponent(id)}/start`, { method: 'POST' })
  },
  endSession(id: string) {
    return request<void>(`/sessions/${encodeURIComponent(id)}/end`, { method: 'POST' })
  },
  retryTrack(id: string, lang: string) {
    return request<void>(`/sessions/${encodeURIComponent(id)}/tracks/${encodeURIComponent(lang)}/retry`, {
      method: 'POST',
    })
  },
  lookupJoin(code: string) {
    return request<JoinInfo>(`/join/${encodeURIComponent(code)}`)
  },
}
