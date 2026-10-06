import type { ReactNode } from 'react'

interface Props {
  tone?: 'info' | 'warn' | 'error'
  /** Show a spinner (for "reconnecting…"). */
  busy?: boolean
  children: ReactNode
}

/** Errors are announced immediately; everything else politely. */
export function Banner({ tone = 'info', busy, children }: Props) {
  return (
    <div className={`banner banner--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {busy && <span className="spinner" aria-hidden="true" />}
      <div>{children}</div>
    </div>
  )
}
