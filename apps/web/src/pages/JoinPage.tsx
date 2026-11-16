import { JOIN_CODE_LENGTH, joinCodeSchema } from "@ads/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Layout } from "../components/Layout.tsx";

export function JoinPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = joinCodeSchema.safeParse(new FormData(e.currentTarget).get("code"));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the code.");
      return;
    }
    await navigate({ to: "/listen/$code", params: { code: parsed.data } });
  }

  return (
    <Layout actions={<Link to="/login" className="button-link">Host login</Link>}>
      <h1>Join a session</h1>
      <p className="lead">Enter the code from the speaker's slide, or scan their QR code.</p>
      <form className="card stack" onSubmit={onSubmit} noValidate>
        <label className="field">
          <span>Session code</span>
          <input
            name="code"
            className="code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={JOIN_CODE_LENGTH + 2}
            placeholder="ABC123"
            aria-invalid={Boolean(error)}
            onChange={() => setError(null)}
          />
          {error && <small className="error" role="alert">{error}</small>}
        </label>
        <button type="submit" className="primary">
          Join
        </button>
      </form>
      <p className="hint center">No account needed.</p>
    </Layout>
  );
}
