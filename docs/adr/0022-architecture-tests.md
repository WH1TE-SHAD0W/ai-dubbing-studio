# 0022. Architecture tests for the worker and the API

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Marek Culak
- **Ticket:** YGP-110

## Context

Several decisions rely on the code keeping a certain shape, but nothing checks it:

- The Gemini adapter sits behind an interface, so the worker doesn't depend on one provider (YGP-99, [ADR-0009](0009-translation-engine-communication.md)). The runner must only use that interface, never the SDK.
- LiveKit is reached through one module in each app ([ADR-0020](0020-input-audio-stream.md)), and Redis only through the job queue ([ADR-0018](0018-autoscaling-architecture-of-translation-container.md)).
- In the API, routes go through the session and track services, which own the database rules (claims, leases, retries).

Today these rules hold only because people remember them. A single import in the wrong place (the Gemini SDK in the runner, or `pg` in a route) still type-checks, passes the tests and gets through a quick review, and the boundary is gone. The more people work on the code, the easier that is to miss.

The checks have to:

- run on every pull request and fail with a message that names the file and the rule;
- cover both languages: Go in `apps/translator` and TypeScript in `apps/api`;
- be short to write and read, using an existing library rather than our own import-parsing code.

## Options considered

1. **No automated check; rely on code review**
    - Pros: nothing to add.
    - Cons: depends on the reviewer spotting one import line; nothing tells a new teammate the rules exist.
2. **Our own tests that read the imports** (`go/packages` in Go, the TypeScript compiler API in the API)
    - Pros: no new dependency; runs inside `go test` and Vitest.
    - Cons: our own code to write and maintain in two languages, which is what a library already does. TypeScript 7 has no compiler API yet, so the API half would need a second parser anyway.
3. **arch-go for the worker**
    - Pros: maintained, can run inside `go test`.
    - Cons: rules are written per package, and there's no "only this package may use this SDK" rule, so each rule has to be repeated for every other package. Used inside tests, it adds its CLI dependencies (cobra, viper and others) to the worker's `go.mod`.
4. **go-arch-lint for the worker and dependency-cruiser for the API**
    - Pros: each is one small config file. go-arch-lint lets each package list what it may import, with SDKs as named vendors, so "only `internal/gemini` uses the Gemini SDK" is one line. dependency-cruiser is the common tool for this in TypeScript, and a rule is a few lines of `from` and `to`. Both run from the command line, so the worker's `go.mod` stays as it is.
    - Cons: two tools with two config formats. dependency-cruiser can't use TypeScript 7 yet, so it needs `@swc/core` to read the files. go-arch-lint isn't part of `go test`, so it needs its own command.
5. **ArchUnitTS for the API**
    - Pros: rules are written as Vitest tests.
    - Cons: younger and less used than dependency-cruiser; it also reads files with the TypeScript compiler.

Rejected: 1, 2, 3 and 5. Option 1 leaves the problem as it is. Option 2 means writing what the libraries already do. Option 3 needs a rule repeated for every package and adds dependencies to the worker. Option 5 brings little over dependency-cruiser and is less proven.

## Decision

We will add architecture tests with **go-arch-lint** for the worker and **dependency-cruiser** for the API, and run both in a new **Architecture** CI job on every pull request, made a required check on `testing`.

### Worker rules (`apps/translator/.go-arch-lint.yml`)

Every package lists the packages and libraries it may import; the standard library is always allowed and nothing else is.

| Rule | Why |
|---|---|
| Only `internal/gemini` imports the Gemini SDK (`google.golang.org/genai`) | The provider can be swapped in one package (YGP-99). |
| Only `internal/livekit` imports the LiveKit SDK and pion | The media transport stays in one package (ADR-0020). |
| Only `internal/jobs` imports Redis | The job queue can change without touching the runner (ADR-0018). |
| `runner` imports only our own packages (`audio`, `control`, `gemini`, `jobs`, `livekit`, `media`) and `errgroup` | The runner uses the interfaces, never an SDK. |
| `cmd` only imports our own packages, no SDK | `cmd` wires things together and holds no logic. |
| Nothing imports `cmd` | Lower layers don't depend on the program that starts them. |
| Only tests import `internal/fakes` (test files aren't checked) | Test doubles never reach the real worker. |

### API rules (`apps/api/.dependency-cruiser.cjs`)

| Rule | Why |
|---|---|
| Only `src/livekit` imports `livekit-server-sdk` | Rooms and tokens are made in one place (ADR-0020). |
| Only `src/queue` imports `ioredis` | The job queue can change in one place (ADR-0018). |
| Routes never import `pg`, `db.ts` or a repo | The services own the database rules. |
| Only `app.ts` imports the routes | Lower layers don't depend on the HTTP layer. |
| No import cycles | Cycles hide which layer depends on which. |

### How they run

- Worker: `go run github.com/fe3dback/go-arch-lint@v1.19.1 check` in `apps/translator`, with the version pinned.
- API: `pnpm --filter @ads/api arch`, with `dependency-cruiser` and `@swc/core` as dev dependencies.
- go-arch-lint checks imports only (`deepScan: false`). Its deep scan also checks which types are passed into a package, and flagged `cmd` handing its own types to the packages it wires, which is what `cmd` is for.

### Trial on a local branch

The rules were tried on a local branch from `development` (2026-11-11):

- Both checks pass on the current code, and the worker rules also pass on the LiveKit branch (YGP-70).
- A temporary file importing the Gemini SDK and a fake in `runner` failed the worker check with both imports named. One importing `livekit-server-sdk`, `pg` and `ioredis` in a route failed three API rules.
- Without `@swc/core`, dependency-cruiser read 0 files and still passed. The parser has to be set to `swc`.

## Consequences

### Good

- The provider and layer boundaries are checked on every pull request, not only remembered.
- A broken rule names the file, the import and the rule, so it's clear what to change.
- The rules files double as a short description of the layers, next to the code.
- No code needs to move: the SDK imports are already only where the rules allow them.

### Bad / trade-offs

- Two more tools and two config formats to learn, one per language.
- Adding a package or an SDK means adding it to the rules file, or the check fails.
- dependency-cruiser depends on swc until it supports TypeScript 7.
- The worker check runs as its own command, outside `go test`.

### Follow-up work

- Add the Architecture job to the CI workflow and to the required checks on `testing` (YGP-110). A repository admin imports the updated ruleset.
- List the rules on the Testing page once the checks are merged.
- Add the same check for `main` together with the other required checks, once the workflows reach `main`.
