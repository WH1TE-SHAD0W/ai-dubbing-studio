import { LOGIN_FAILED_MESSAGE, loginRequestSchema } from "@ads/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Layout } from "../components/Layout.tsx";
import { authClient } from "../lib/auth.ts";
import { fieldErrors } from "../lib/form.ts";

export function LoginPage() {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = loginRequestSchema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const { error } = await authClient.signIn.email(parsed.data);
    setBusy(false);
    if (error) {
      // Same message whether or not the email exists (ADR-0003).
      setErrors({ form: error.status === 429 ? "Too many attempts. Wait a minute and try again." : LOGIN_FAILED_MESSAGE });
      return;
    }
    await navigate({ to: "/studio" });
  }

  return (
    <Layout>
      <h1>Host login</h1>
      <form className="card stack" onSubmit={onSubmit} noValidate>
        {errors.form && <p className="error" role="alert">{errors.form}</p>}
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} />
          {errors.email && <small className="error">{errors.email}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input name="password" type="password" autoComplete="current-password" aria-invalid={Boolean(errors.password)} />
          {errors.password && <small className="error">{errors.password}</small>}
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
      <p className="hint center">Forgot your password? Password reset isn't available yet; ask whoever runs the app.</p>
      <p className="center">
        New host? <Link to="/register">Create an account</Link>
      </p>
    </Layout>
  );
}
