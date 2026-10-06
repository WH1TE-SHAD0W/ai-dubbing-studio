import { useEffect, useState } from 'react'

export type Async<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: unknown }

/** Runs `fn` when `deps` or `retryKey` change; ignores results that arrive after a newer run or unmount. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], retryKey = 0): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    fn().then(
      (data) => live && setState({ status: 'ok', data }),
      (error) => live && setState({ status: 'error', error }),
    )
    return () => {
      live = false
    }
  }, [...deps, retryKey])
  return state
}
