import { useLocation } from 'react-router-dom'
import { api } from '../api/client'
import type { JoinInfo } from '../api/types'
import { useAsync, type Async } from '../lib/useAsync'

/** Session info for a room code. Reuses what the join screen already fetched, otherwise asks the API. */
export function useJoinInfo(code: string, retryKey = 0): Async<JoinInfo> {
  const preloaded = (useLocation().state as { info?: JoinInfo } | null)?.info
  const fetched = useAsync(() => (preloaded ? Promise.resolve(preloaded) : api.lookupJoin(code)), [code], retryKey)
  return preloaded ? { status: 'ok', data: preloaded } : fetched
}
