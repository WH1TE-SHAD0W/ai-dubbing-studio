# 0015. Better Auth for host login

- **Status:** Proposed
- **Date:** 2026-10-30
- **Deciders:** Marek Culak
- **Ticket:** YGP-48

## Context

Only hosts have accounts, with email and password; listeners have none. Hosts are stored in Postgres (ADR-0002). The backend writes its own queries for sessions; the library would manage its own account and login tables. The PoC has one hardcoded account from environment variables and says it is not a user system.

[ADR-0003](./0003-host-authentication.md) decides that hosts log in through a maintained library rather than custom code, and how it is configured (logins stored in the database, Argon2id hashing). This ADR records which library that is. The backend is built on Hono, so the pick must integrate with it, support email and password, and work with Postgres.

## Options considered

1. **Better Auth**: TypeScript auth library with native Hono support.
    - Pros: Dedicated Hono handler (`auth.handler`); first-class email and password support; built-in sessions, password reset, and database adapters; runs directly inside our API process.
    - Cons: Newer library with a growing community; brings its own tables/schema conventions.
2. **Auth.js**: Widely used auth library with a Hono adapter.
    - Pros: Ecosystem dominance; extensive provider options.
    - Cons: Email/password via `Credentials` provider is treated as a secondary use-case (does not auto-manage password hashing, DB persistence, or password resets out of the box).
3. **Lucia**: Lightweight session architecture resource.
    - Pros: Simple session patterns; direct control over database schema.
    - Cons: Deprecated as a library (transitioned to educational guides); registration, hashing, and password resets are entirely unmanaged.
4. **Keycloak**: full identity server.
    - Pros: complete accounts, resets and roles without writing auth code.
    - Cons: heavy to run and operate for a hosts-only app.
5. **Clerk or Auth0**: hosted identity services.
    - Pros: fastest to add; ready-made pages.
    - Cons: external vendor with per-user cost; a third party holds host accounts.
6. **Custom code**.
    - Pros: full control; no dependency; fits plain SQL.
    - Cons: we own hashing, sessions, resets and their security; the most time.
7. **PoC hardcoded account**.
    - Pros: nothing to build.
    - Cons: one account from environment variables, no registration; the PoC calls it a stand-in, not a user system.

## Decision

We propose Better Auth, because it has a specific integration library for our framework, covers email and password, and avoids custom security code. It is the library that [ADR-0003](./0003-host-login.md) configures. The status stays Proposed until the pull request using it is in place.

**Why the other options are not the best fit:**

- **Auth.js**: Built primarily around OAuth/Magic Link conventions. Its `Credentials` provider requires us to manually write and maintain password hashing, reset endpoints, and user persistence logic.
- **Lucia**: No longer maintained as a package dependency (now an educational guide site), shifting full maintenance burden onto us.
- **Keycloak**: more than a hosts-only app needs to run and operate.
- **Clerk or Auth0**: account data would leave our platform and cost grows with users; ADR-0002 rejects a hosted database for the same privacy reason.
- **Custom code**: possible, but hashing, sessions and resets become our responsibility, which a maintained library already covers (see ADR-0003).
- **PoC hardcoded account**: a stand-in with no registration, so it cannot support the Register page.

## Consequences

- Good: less custom auth code; native Hono fit; stays in our stack; account and login tables, and their queries, are managed by the library (see [ADR-0002](./0002-session-and-account-storage.md)).
- Bad / trade-offs: smaller community than the alternatives; its tables are created by its own tool, so schema changes come from two sources (our migrations and the library's) and need to be run together. (see [ADR-0002](./0002-session-and-account-storage.md)).
- Follow-up work: none for this ADR. Configuration follow-ups are tracked in ADR-0003.