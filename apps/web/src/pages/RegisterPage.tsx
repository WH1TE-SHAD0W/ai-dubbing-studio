import { PASSWORD_MAX, PASSWORD_MIN, registerRequestSchema } from "@ads/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Layout } from "../components/Layout.tsx";
import { authClient } from "../lib/auth.ts";
import { fieldErrors } from "../lib/form.ts";

export function RegisterPage() {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = registerRequestSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setBusy(true);
    const { error } = await authClient.signUp.email(parsed.data);
    setBusy(false);
    if (error) {
      setErrors({ form: error.message ?? "Couldn't create the account. Try again." });
      return;
    }
    await navigate({ to: "/studio" });
  }

  return (
    <Layout>
      <h1>Create a host account</h1>
      <p className="lead">Hosts run sessions. Listeners don't need an account.</p>
      <form className="card stack" onSubmit={onSubmit} noValidate>
        {errors.form && <p className="error" role="alert">{errors.form}</p>}
        <label className="field">
          <span>Name</span>
          <input name="name" autoComplete="name" aria-invalid={Boolean(errors.name)} />
          {errors.name && <small className="error">{errors.name}</small>}
        </label>
        <label className="field">
          <span>Email</span>
          <input name="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} />
          {errors.email && <small className="error">{errors.email}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            aria-invalid={Boolean(errors.password)}
            aria-describedby="password-hint"
          />
          <small id="password-hint" className="hint">
            {PASSWORD_MIN} to {PASSWORD_MAX} characters. Spaces are fine; a short phrase works well.
          </small>
          {errors.password && <small className="error">{errors.password}</small>}
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="center">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </Layout>
  );
}
