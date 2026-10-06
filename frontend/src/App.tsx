import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { currentHost } from './auth/auth'
import { useOnline } from './lib/useOnline'
import { CreateSessionPage } from './pages/CreateSession'
import { JoinLinkRedirect, JoinPage } from './pages/Join'
import { ListenLivePage } from './pages/ListenLive'
import { ListenSetupPage } from './pages/ListenSetup'
import { NotFoundPage, OfflineScreen } from './pages/Misc'
import { SignInPage } from './pages/SignIn'
import { StudioPage } from './pages/Studio'

// Dev-only visual harness; `import.meta.env.DEV` is false in production builds, so this is dropped from the bundle.
const DevPreview = import.meta.env.DEV ? lazy(() => import('./pages/DevPreview')) : null

/** Live audio needs the network: show a clear screen instead of a broken page. */
function Online({ children }: { children: ReactNode }) {
  return useOnline() ? children : <OfflineScreen />
}

function RequireHost({ children }: { children: ReactNode }) {
  const location = useLocation()
  if (!currentHost()) return <Navigate to="/signin" replace state={{ from: location.pathname }} />
  return children
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/join" replace />} />

        <Route path="/signin" element={<Online><SignInPage /></Online>} />
        <Route
          path="/sessions/new"
          element={
            <RequireHost>
              <Online>
                <CreateSessionPage />
              </Online>
            </RequireHost>
          }
        />
        <Route
          path="/studio/:id"
          element={
            <RequireHost>
              <Online>
                <StudioPage />
              </Online>
            </RequireHost>
          }
        />

        <Route path="/join" element={<Online><JoinPage /></Online>} />
        <Route path="/j/:code" element={<JoinLinkRedirect />} />
        <Route path="/listen/:code/setup" element={<Online><ListenSetupPage /></Online>} />
        {/* No Online wrapper here: a dropped connection shows the reconnect banner instead. */}
        <Route path="/listen/:code" element={<ListenLivePage />} />

        {DevPreview && (
          <Route
            path="/dev/preview"
            element={
              <Suspense fallback={null}>
                <DevPreview />
              </Suspense>
            }
          />
        )}

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}
