import { Link } from 'react-router-dom'
import { AppBar } from '../components/AppBar'

export function OfflineScreen() {
  return (
    <>
      <AppBar />
      <main className="page page--center">
        <div className="center-state" role="alert">
          <h1>You’re offline</h1>
          <p className="muted">Live translation needs a network connection. This screen will clear when you’re back online.</p>
          <button type="button" className="btn btn--outline" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </main>
    </>
  )
}

export function NotFoundPage() {
  return (
    <>
      <AppBar />
      <main className="page page--center">
        <div className="center-state">
          <h1>Page not found</h1>
          <Link to="/join" className="btn btn--primary">
            Join a session
          </Link>
        </div>
      </main>
    </>
  )
}
