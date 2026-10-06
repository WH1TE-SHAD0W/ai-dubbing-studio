import { useSyncExternalStore } from 'react'
import type { Store } from './types'

export function useLive<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState)
}

/** Minimal observable state holder that the Live implementations (and tests) build on. */
export function createStore<S>(initial: S): Store<S> & { setState(patch: Partial<S>): void } {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setState: (patch) => {
      state = { ...state, ...patch }
      listeners.forEach((l) => l())
    },
  }
}
