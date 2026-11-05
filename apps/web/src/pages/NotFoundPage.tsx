import { Link } from "@tanstack/react-router";
import { Layout } from "../components/Layout.tsx";

export function NotFoundPage() {
  return (
    <Layout>
      <section className="card stack">
        <h1>Page not found</h1>
        <Link to="/join" className="button-link">
          Join a session
        </Link>
      </section>
    </Layout>
  );
}
