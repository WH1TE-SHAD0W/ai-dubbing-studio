import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Session } from "@ads/contracts";
import { Layout } from "../../components/Layout.tsx";
import { api } from "../../lib/api.ts";
import { authClient, useSession } from "../../lib/auth.ts";
import { useAsync } from "../../lib/useAsync.ts";
import { ControlRoom } from "./ControlRoom.tsx";
import { CreateSessionForm } from "./CreateSessionForm.tsx";

const route = getRouteApi("/studio");

// One host workspace (ADR-0014): the create form, then the control room for that
// session. The session id lives in the URL (?session=…) so a reload keeps it.
export function StudioPage() {
  const { session: sessionId } = route.useSearch();
  const navigate = useNavigate();
  const login = useSession();

  async function logOut() {
    await authClient.signOut();
    await navigate({ to: "/login" });
  }

  const openSession = (id: string | undefined) => void navigate({ to: "/studio", search: id ? { session: id } : {} });

  return (
    <Layout
      actions={
        <>
          {login.data?.user && <span className="hint">{login.data.user.name}</span>}
          <button type="button" className="link" onClick={() => void logOut()}>
            Log out
          </button>
        </>
      }
    >
      <h1>Studio</h1>
      {sessionId ? (
        <SessionLoader key={sessionId} id={sessionId} onNew={() => openSession(undefined)} />
      ) : (
        <CreateSessionForm onCreated={openSession} />
      )}
    </Layout>
  );
}

function SessionLoader({ id, onNew }: { id: string; onNew: () => void }) {
  const loaded = useAsync(() => api.getSession(id), [id]);
  // Going live or ending returns the updated session; it replaces the loaded one.
  const [updated, setUpdated] = useState<Session | null>(null);
  const session = updated ?? (loaded.status === "ready" ? loaded.data : null);

  if (!updated && loaded.status === "error") {
    return (
      <div className="card stack">
        <p className="error" role="alert">{loaded.error.message}</p>
        <div className="row wrap">
          <button type="button" className="secondary" onClick={loaded.reload}>
            Try again
          </button>
          <button type="button" className="link" onClick={onNew}>
            Create a new session
          </button>
        </div>
      </div>
    );
  }
  if (!session) return <p className="hint">Loading session…</p>;
  return <ControlRoom session={session} onChange={setUpdated} onNew={onNew} />;
}
