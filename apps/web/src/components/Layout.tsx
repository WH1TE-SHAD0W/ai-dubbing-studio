import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useUpdateAvailable } from "../lib/pwa.ts";

export function Layout({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const update = useUpdateAvailable();
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          AI Dubbing Studio
        </Link>
        <div className="topbar-actions">{actions}</div>
      </header>
      {update.available && (
        <div className="banner" role="status">
          A new version is available.
          <button type="button" className="link" onClick={update.reload}>
            Reload
          </button>
        </div>
      )}
      <main className="page">{children}</main>
    </div>
  );
}
