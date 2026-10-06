import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface Props {
  /** Where the brand links to. */
  home?: string
  children?: ReactNode
}

export function AppBar({ home = '/join', children }: Props) {
  return (
    <header className="appbar">
      <Link to={home} className="brand">
        <span className="brand__mark" aria-hidden="true" />
        AI Dubbing Studio
      </Link>
      {children && <div className="appbar__right">{children}</div>}
    </header>
  )
}
