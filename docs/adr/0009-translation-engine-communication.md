# 0009. Session creation contract and provider selection

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-43

## Context

When the host creates a session in the Studio, Hono asks the dubbing container to create the streams. The host picks the provider in the UI. Only Gemini is available now, but more providers must be possible later. The proposal makes the engine pluggable.

## Options considered

1. **Hono sends session id, languages and provider in the request**; the container picks the adapter from it.
    - Pros: the container stays stateless; provider chosen per session; small contract.
    - Cons: the provider list and supported languages must stay in sync across UI, Hono and container.
2. **Provider fixed in container configuration (.env or config.json)**.
    - Pros: simplest to build; nothing to validate in the request.
    - Cons: no per-session choice; changing provider needs a redeploy.
3. **Container looks up the session itself in a shared store**.
    - Pros: Hono sends only an id; one source of truth.
    - Cons: couples the container to the database, which is outside our scope; an extra dependency and failure point.

## Decision

We will use option 1, because it keeps the logic in the contract. The languages carry both source and destination. Illustrative payload (final field names go in the shared schema):

```json
{
  "sessionId": "...",
  "languages": { "source": "de", "destinations": ["en", "sk"] },
  "provider": "gemini"
}
```

The only accepted provider value for now is `gemini`.

**Why the other options are not the best fit:**

- **Fixed provider**: the host picks the provider in the UI, which a fixed setting cannot honour, and switching would need a redeploy.
- **Shared store**: it makes the container depend on the database, which is going to create a tightly coupled system, while the request already carries everything the container needs.

## Consequences

- Good: adding a provider means a new adapter plus one allowed value; per-session choice.
- Bad / trade-offs: the provider list must stay in sync across UI, Hono and container; supported languages depend on the provider (the PoC shows an unsupported language only as a failed track).
- Follow-up work: open questions: response and readiness semantics; validating languages per provider; maximum destination languages (the PoC caps at 5); where speaker consent is captured (the PoC includes it in session creation, this contract does not).
