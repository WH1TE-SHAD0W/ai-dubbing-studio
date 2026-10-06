import { useNavigate } from 'react-router-dom'
import { currentHost, signOut } from '../auth/auth'
import { AppBar } from './AppBar'

/** App bar for the signed-in host screens: "Host: <name>" plus sign-out. */
export function HostBar() {
  const navigate = useNavigate()
  const host = currentHost()
  return (
    <AppBar home="/sessions/new">
      <span>
        <span className="hide-narrow">Host: </span>
        {host?.name ?? 'Host'}
      </span>
      <button
        type="button"
        className="linklike nowrap"
        onClick={() => {
          void signOut()
          navigate('/signin', { replace: true })
        }}
      >
        Sign out
      </button>
    </AppBar>
  )
}
