# 0016. Zod for schemas and validation

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-49

## Context

Zod is a TypeScript-first library where a schema is declared once and used both to validate data at runtime and to infer the static type. Our boundaries need that: requests to Hono, the Hono-to-dubbing-container contract (ADR 0009), forms in the PWA, and environment configuration. The HLD also needs a specified REST API.

## Options considered

1. **Zod**: TypeScript-first schema library.
    - Pros: widest adoption; native Hono validator middleware; schemas shared between client and server; infers TypeScript types.
    - Cons: adds to the browser bundle.
2. **Valibot**: modular schema library.
    - Pros: smaller bundles.
    - Cons: younger, smaller ecosystem.
3. **TypeScript types only**.
    - Pros: no cost, no dependency.
    - Cons: types disappear at runtime, so nothing is validated at the boundary.
4. **JSON Schema or OpenAPI first, with code generation**.
    - Pros: language-neutral contract, useful if the dubbing container is not TypeScript.
    - Cons: extra tooling and a generation step.
5. **Joi or Yup**.
    - Pros: mature and well known.
    - Cons: older design; weaker type inference.

## Decision

We will use Zod, with the schemas in one shared package in a monorepo and Hono's typed RPC client (hc) in the PWA, so the API contract is written once and checked at both ends.

**Why the other options are not the best fit:**

- **Valibot**: a smaller bundle is attractive for a mobile PWA, but we have not measured a bundle problem and Zod has the broadest support.
- **TypeScript types only**: validates nothing at runtime, so malformed requests would reach the code.
- **JSON Schema first**: adds a generation step to a TypeScript stack; worthwhile only if a non-TypeScript service must share the contract.
- **Joi or Yup**: weaker type inference means maintaining types by hand beside the schemas.

## Consequences

- Good: one source of truth for types and validation; end-to-end typing from Hono to the PWA.
- Bad / trade-offs: Zod in the browser bundle; a non-TypeScript dubbing container cannot import the schemas directly (JSON Schema export is possible).
- Follow-up work: open questions: monorepo tooling; where the dubbing contract schemas live; generating OpenAPI from the schemas for the HLD.
