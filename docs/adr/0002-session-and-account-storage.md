# 0002. How session and account data is stored

- **Status:** Proposed
- **Date:** 2026-10-27
- **Deciders:** Jamie
- **Ticket:** YGP-10

## Context

Today the backend keeps every session in memory, and there is one host account
hard-coded in environment variables. Nothing survives a restart.

The app now needs:

- **Host accounts:** anyone can sign up, with passwords stored as hashes.
- **Sessions:** id, join code, title, spoken language, host, status, and the
  created / started / ended times with the reason it ended.
- **Target languages:** one or more per session.
- **Usage summary:** peak listeners per language, to see where the Gemini cost
  goes (duration comes from the session's start and end times).

What is deliberately **not** stored:

- **Audio** (host or translated): privacy, see [ADR-0001](0001-audio-fan-out.md).
- **Transcripts and captions:** they record what people said (personal data), and
  no feature needs them after the session.
- **Live state** (connections, speaking, latency): it changes many times a second
  and means nothing after a restart, so it stays in memory.
- **Listener identities:** listeners are anonymous; only counts are kept.
- **Secrets** (API keys): these stay in environment variables.

Constraints:

- Join codes are short, so they must be reused: they only need to be unique among
  sessions that have not ended.
- Ended sessions are deleted after a set time (see Consequences).
- Self-hosted with Docker Compose; a small student team with a fixed deadline.

## Options considered

### A. Where the data lives

1. **Keep everything in memory** (today).
    - Pros: nothing to add.
    - Cons: a restart or redeploy deletes every host account and session, so hosts
      would have to sign up again.

2. **SQLite** (a database file inside the backend container).
    - Pros: no extra service; simple.
    - Cons: one writer at a time, and the file is tied to one backend container,
      so it can't be shared if the backend is ever scaled out.

3. **PostgreSQL** (its own container in Docker Compose).
    - Pros: handles many connections; supports partial unique indexes (for join
      codes); widely used; free and open source.
    - Cons: one more service to run and back up.

4. **Hosted database** (e.g. Supabase, Neon).
    - Pros: nothing to run ourselves.
    - Cons: costs money as usage grows, and account data leaves our own platform
      (the same privacy concern as a hosted SFU in ADR-0001).

### B. How the backend talks to the database

1. **Plain SQL with the `pg` library**, tables created by `.sql` migration files.
    - Pros: every query we write is visible and easy to explain; one small
      dependency.
    - Cons: more code written by hand; query results are not type-checked.

2. **Query builder** (e.g. Kysely).
    - Pros: TypeScript checks queries against the tables.
    - Cons: another tool to learn; still needs its own migration setup.

3. **ORM** (e.g. Prisma).
    - Pros: little SQL to write; migrations included.
    - Cons: hides what the database actually does; heavy for two tables of our own.

### C. Storing a session's target languages

1. **Separate table** `session_languages (session_id, lang)`.
    - Pros: the standard normalised design; per-language usage fits here too.
    - Cons: reading a session needs a join.

2. **Array column** `target_langs text[]` on `sessions`.
    - Pros: simpler to read and write.
    - Cons: PostgreSQL-only, and per-language data doesn't fit in it.

## Decision

We will store host accounts, sessions and target languages (with their usage) in
**PostgreSQL** (option A3), accessed with **plain SQL through the `pg` library**
(option B1), with target languages in a **separate `session_languages` table**
(option C1).

Why:

- **PostgreSQL:** accounts must survive restarts (rules out A1). It runs as one more
  container in the existing Docker Compose setup, keeps account data on our own
  platform (rules out A4), and is not tied to one backend container (unlike A2).
  Its **partial unique index** gives exactly the join-code rule we need:
  `UNIQUE (join_code) WHERE status <> 'ended'`.
- **Plain SQL with `pg`:** only two tables are ours (`sessions` and
  `session_languages`), with a handful of queries; Better Auth manages its own
  tables and queries (ADR-0003). Writing ours by hand keeps them visible and easy
  to explain and review, and adds one small dependency instead of a new tool. Our
  tables are created by numbered `.sql` migration files kept in the repository.
- **Separate languages table:** it is the normalised design, and per-language
  usage (peak listeners for each language) has a natural place to live.

## Consequences

- Good: host accounts and sessions survive restarts and redeploys.
- Good: the database itself enforces the join-code rule, even with more than one
  backend instance.
- Good: no audio, transcripts or listener identities are stored, so a database leak
  exposes far less personal data.
- Bad / trade-offs: one more service in Docker Compose, with its data on a volume
  that needs backing up.
- Bad / trade-offs: queries are not type-checked, so they need tests against a real
  PostgreSQL database.
- Bad / trade-offs: the backend can't start without the database, so local
  development and CI need a PostgreSQL container too.

Follow-up work:

- Add a `postgres` service and volume to `docker-compose.yml`, and a
  `DATABASE_URL` setting to the Hono API container. The dubbing container has no
  database access (ADR-0008, ADR-0009).
- Write the first migration: `sessions` and `session_languages` (with
  `peak_listeners`), with the partial unique index on `join_code`. Host accounts
  and logins use Better Auth's own tables, created by its command-line tool
  (ADR-0003).
- Hash passwords with Argon2id (ADR-0003).
- Keep ended sessions for 30 days (to be reviewed), deleted by a daily cleanup job.
  Deleting a session also deletes its languages.
- Trial Kysely (option B2) in the prototype, if time allows. Kysely runs on top of
  `pg` and uses the same tables, so trying it doesn't change the schema. If it works
  well, a new ADR records the switch.
