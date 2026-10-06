import { api } from '../api/client'
import { load, remove, save } from '../lib/storage'

// The backend owns the (hardcoded, no-database) login and sets an httpOnly cookie. This module only
// keeps a UI hint in localStorage so screens know who is signed in without an extra round trip.
// If the cookie is gone, any API call returns 401 and api/client.ts sends the user back to /signin.

const KEY = 'ads.host'

export interface Host {
  name: string
}

/** Throws ApiError: 401 wrong credentials, 429 rate-limited, status 0 backend unreachable. */
export async function signIn(email: string, password: string): Promise<Host> {
  const { name } = await api.signIn(email, password)
  const host = { name }
  save(KEY, host)
  return host
}

export function currentHost(): Host | null {
  return load<Host>(KEY)
}

export async function signOut(): Promise<void> {
  remove(KEY)
  try {
    await api.signOut()
  } catch {
    /* the cookie expires on its own; the local hint is already cleared */
  }
}
