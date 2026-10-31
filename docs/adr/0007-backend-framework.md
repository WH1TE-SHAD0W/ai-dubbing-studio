# 0007. Hono as the API framework

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-n

## Context

The control plane authenticates hosts and connects listeners to a session. It must scale quickly at the start of a conference (100 to 5k listeners joining in a short window), answer in about 100 ms, run as a container on our own k8s cluster, and stay simple for a two-person MVP. The stack is Node.js and TypeScript.

## Options considered

1. **Hono**: small, TypeScript-first framework built on web-standard Request/Response.
    - Pros: Zod validator middleware and a typed RPC client; serves static files; dedicated Better Auth integration; light enough to scale quickly.
    - Cons: smaller community and fewer examples than Express.
2. **Express**: the most widely used Node framework.
    - Pros: largest ecosystem, the most tutorials and examples.
    - Cons: older design; TypeScript types and validation are bolted on; no typed client.
3. **Fastify**: fast framework with schema-based validation and plugins.
    - Pros: good performance; built-in validation; mature plugin ecosystem.
    - Cons: heavier conventions; weaker end-to-end typing for the PWA client.
4. **NestJS**: structured framework with dependency injection.
    - Pros: clear architecture for large codebases; many built-in modules.
    - Cons: a lot of boilerplate for a small API and a two-person team.

## Decision

We will use Hono on the Node.js runtime because it is the leanest option that still gives end-to-end types with Zod (ADR 0017), serves the PWA itself (ADR 0012) and has a native Better Auth integration (ADR 0016).

**Why the other options are not the best fit:**

- **Express**: it works, but it gives no typed client and no built-in validation story, so the contract shared with the PWA (ADR 0017) would be glue code we write ourselves.
- **Fastify**: a good performer, but its typing does not reach the PWA the way Hono's typed client does, and an API this small does not need its extra conventions.
- **NestJS**: built for large codebases; its structure and boilerplate cost more than they save for a handful of endpoints and two developers.

## Consequences

- Good: small and fast to start; typed client for the PWA; one framework for API and static files.
- Bad / trade-offs: fewer examples and a smaller community than Express; we learn it as we build.
- Follow-up work: load-test the join endpoint for the conference-start burst (numbers to be set at a later stage of development).
