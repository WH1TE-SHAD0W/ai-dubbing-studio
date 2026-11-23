import { FEEDBACK_MAX_LENGTH, feedbackRequestSchema } from "@ads/contracts";
import { type FormEvent, useState } from "react";
import { api } from "../../lib/api.ts";
import { fieldErrors } from "../../lib/form.ts";

// Shown to a listener once the session has ended and they are disconnected (YGP-120).
// Public: no login. Only the message is required; rating and email are optional.
export function FeedbackForm({ sessionId }: { sessionId?: string }) {
  const [rating, setRating] = useState<number | undefined>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <section className="card stack">
        <p role="status">Thank you, your feedback was sent.</p>
      </section>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const parsed = feedbackRequestSchema.safeParse({
      message: String(data.get("message") ?? ""),
      rating,
      email: email || undefined,
      sessionId,
    });
    setFailure(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSending(true);
    try {
      await api.sendFeedback(parsed.data);
      setSent(true);
    } catch (err) {
      // The form stays as it is, so the typed text isn't lost.
      setFailure(err instanceof Error ? err.message : "Couldn't send your feedback. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card" aria-labelledby="feedback-heading">
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <h2 id="feedback-heading">How was it?</h2>
        <div className="field">
          <span id="rating-label">Rating (optional)</span>
          <div className="chips" role="group" aria-labelledby="rating-label">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                className={`chip ${rating === n ? "chip-on" : ""}`}
                aria-pressed={rating === n}
                aria-label={`${n} out of 5`}
                onClick={() => setRating(rating === n ? undefined : n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          Your feedback
          <textarea name="message" rows={4} maxLength={FEEDBACK_MAX_LENGTH} aria-invalid={Boolean(errors.message)} />
        </label>
        {errors.message && <p className="error" role="alert">Write a message, up to {FEEDBACK_MAX_LENGTH} characters.</p>}
        <label className="field">
          Your email, if you want an answer (optional)
          <input name="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} />
        </label>
        {errors.email && <p className="error" role="alert">Enter a valid email address or leave it empty.</p>}
        {failure && <p className="error" role="alert">{failure}</p>}
        <button type="submit" className="primary" disabled={sending}>
          {sending ? "Sending…" : "Send feedback"}
        </button>
      </form>
    </section>
  );
}
