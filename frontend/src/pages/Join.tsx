import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError, describeError } from '../api/client'
import { AppBar } from '../components/AppBar'
import { Banner } from '../components/Banner'
import { formatJoinCode, isCompleteJoinCode, normalizeJoinCode } from '../lib/joinCode'

/** /j/:code shared links go straight to the language screen. */
export function JoinLinkRedirect() {
  const { code = '' } = useParams()
  return <Navigate to={`/listen/${normalizeJoinCode(code)}/setup`} replace />
}

export function JoinPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const normalized = normalizeJoinCode(code)
    if (!isCompleteJoinCode(normalized) || busy) return
    setBusy(true)
    setError(null)
    try {
      const info = await api.lookupJoin(normalized)
      navigate(`/listen/${normalized}/setup`, { state: { info } })
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'No live session has that code. Check it with the host.'
          : describeError(err),
      )
      setBusy(false)
    }
  }

  return (
    <>
      <AppBar />
      <main className="page">
        <form className="form-stack" onSubmit={submit} noValidate>
          <div style={{ paddingTop: 8 }}>
            <h1>Join a session</h1>
            <p className="muted">Enter the room code shown by the host.</p>
          </div>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="field">
            <label className="label" htmlFor="code">
              Room code
            </label>
            <input
              id="code"
              className="input input--code"
              value={formatJoinCode(code)}
              onChange={(e) => {
                setCode(normalizeJoinCode(e.target.value))
                setError(null)
              }}
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="KX7-4M2"
              aria-describedby="code-help"
            />
          </div>

          <div>
            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={!isCompleteJoinCode(code) || busy}
            >
              {busy ? 'Checking…' : 'Join as guest'}
            </button>
            <p id="code-help" className="muted small" style={{ textAlign: 'center', marginTop: 8 }}>
              No account needed.
            </p>
          </div>
        </form>

        <p className="muted" style={{ textAlign: 'center', marginTop: 'auto' }}>
          Hosting a session? <Link to="/signin">Host sign-in</Link>
        </p>
      </main>
    </>
  )
}
