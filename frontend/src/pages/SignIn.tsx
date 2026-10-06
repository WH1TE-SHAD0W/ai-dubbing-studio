import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { AppBar } from '../components/AppBar'
import { Banner } from '../components/Banner'
import { ApiError, describeError } from '../api/client'
import { currentHost, signIn } from '../auth/auth'

export function SignInPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resetNotice, setResetNotice] = useState(false)
  // Where the host was headed when a guard sent them here.
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/sessions/new'

  if (currentHost()) return <Navigate to={from} replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setResetNotice(false)
    setError(null)
    setBusy(true)
    try {
      await signIn(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401 ? 'Email or password is incorrect.' : describeError(err),
      )
      setBusy(false)
    }
  }

  return (
    <>
      <AppBar />
      <main className="page page--center">
        <form className="card" onSubmit={submit} noValidate>
          <div>
            <h1>Host sign-in</h1>
            <p className="muted">Real-time translation in the speaker’s own voice</p>
          </div>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="field">
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="name@university.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <div className="field-row">
              <label className="label" htmlFor="password">
                Password
              </label>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  setError(null)
                  setResetNotice(true)
                }}
              >
                Forgot password?
              </button>
            </div>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {resetNotice && (
            <Banner>Password reset by email isn’t available in this build. Ask your administrator to change it.</Banner>
          )}

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="divider">or</div>

          <p className="muted" style={{ textAlign: 'center' }}>
            Have a room code? <Link to="/join">Join without an account</Link>
          </p>
        </form>
      </main>
    </>
  )
}
